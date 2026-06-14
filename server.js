require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { YoutubeTranscript } = require("youtube-transcript");
const OpenAI = require("openai");
const { XMLParser } = require("fast-xml-parser");
const ffmpeg = require("fluent-ffmpeg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// --------------- Platform Detection ---------------

function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function extractApplePodcastIds(url) {
  const showMatch = url.match(/podcasts\.apple\.com\/.+\/id(\d+)/i);
  if (!showMatch) return null;
  const episodeMatch = url.match(/[?&]i=(\d+)/);
  return { showId: showMatch[1], episodeId: episodeMatch?.[1] || null };
}

function detectPlatform(url) {
  if (extractYouTubeId(url)) return "youtube";
  if (extractApplePodcastIds(url)) return "apple";
  return null;
}

// --------------- Helpers ---------------

function buildGoogleBooksLink(title, author) {
  const q = encodeURIComponent(`"${title}" ${author}`);
  return `https://books.google.com/books?q=${q}`;
}

// --------------- YouTube Transcript ---------------

async function fetchYoutubeTranscript(videoId) {
  const snippets = await YoutubeTranscript.fetchTranscript(videoId);
  return snippets.map((s) => s.text).join(" ");
}

// --------------- Apple Podcasts Audio Pipeline ---------------

async function resolveApplePodcastAudioUrl(showId, episodeId) {
  const lookupRes = await fetch(`https://itunes.apple.com/lookup?id=${showId}`);
  if (!lookupRes.ok) throw new Error(`iTunes lookup failed (HTTP ${lookupRes.status}).`);
  const lookup = await lookupRes.json();
  if (!lookup.resultCount) throw new Error("Podcast show not found on Apple Podcasts.");
  const feedUrl = lookup.results[0].feedUrl;
  if (!feedUrl) throw new Error("No RSS feed URL found for this podcast.");

  const feedRes = await fetch(feedUrl);
  if (!feedRes.ok) throw new Error(`RSS feed fetch failed (HTTP ${feedRes.status}).`);
  const feedXml = await feedRes.text();

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const parsed = parser.parse(feedXml);
  const items = parsed.rss?.channel?.item;
  if (!items) throw new Error("No episodes found in RSS feed.");

  const itemsArr = Array.isArray(items) ? items : [items];
  let episode = null;

  if (episodeId) {
    episode = itemsArr.find((item) => {
      const guid = item.guid;
      const g = guid && typeof guid === "object" ? guid["#text"] : guid;
      return g === episodeId || g?.endsWith(`/${episodeId}`);
    });
  }

  if (!episode) episode = itemsArr[0];
  if (!episode) throw new Error("Could not find an episode in the RSS feed.");

  const enc = episode.enclosure;
  if (!enc) throw new Error("No audio enclosure found for this episode.");
  const audioUrl = enc["@_url"] || enc.url;
  if (!audioUrl) throw new Error("Audio URL missing from episode enclosure.");

  return audioUrl;
}

// --------------- ffmpeg Helpers ---------------

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(new Error(`ffprobe failed: ${err.message}`));
      else resolve(data.format.duration);
    });
  });
}

function extractSegment(inputPath, outputPath, startSec, durationSec) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSec)
      .duration(durationSec)
      .audioBitrate("64k")
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`ffmpeg segment extraction failed: ${err.message}`)))
      .run();
  });
}

// --------------- Chunked Transcription (Apple only) ---------------

async function transcribeChunk(base64Audio, apiKey, model) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe this audio segment word for word. Return only the transcript text, no commentary.",
            },
            { type: "input_audio", input_audio: { data: base64Audio, format: "mp3" } },
          ],
        },
      ],
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Transcription request failed (HTTP ${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function transcribeAudioUrl(audioUrl) {
  const key = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_AUDIO_MODEL || "openai/gpt-audio-mini";
  const CHUNK_SEC = 300;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "podcast-"));
  const originalPath = path.join(tmpDir, "source");

  try {
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) throw new Error(`Audio download failed (HTTP ${audioRes.status}).`);
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    fs.writeFileSync(originalPath, buffer);

    let duration;
    try {
      duration = await probeDuration(originalPath);
    } catch {
      throw new Error(
        "Could not read audio duration. Is ffmpeg installed? Install it via 'apt install ffmpeg' (Linux), 'brew install ffmpeg' (macOS), or download from ffmpeg.org (Windows)."
      );
    }

    if (duration < 1) throw new Error("Audio file is too short (under 1 second).");

    const numChunks = Math.ceil(duration / CHUNK_SEC);
    let fullTranscript = "";

    for (let i = 0; i < numChunks; i++) {
      const start = i * CHUNK_SEC;
      const chunkPath = path.join(tmpDir, `chunk-${i}.mp3`);

      await extractSegment(originalPath, chunkPath, start, CHUNK_SEC);
      const chunkBuffer = fs.readFileSync(chunkPath);

      if (chunkBuffer.length > 30 * 1024 * 1024) {
        throw new Error(`Segment ${i + 1} exceeds 30 MB — try a shorter episode or reduce CHUNK_SEC.`);
      }

      const base64 = chunkBuffer.toString("base64");
      const text = await transcribeChunk(base64, key, model);
      fullTranscript += text + "\n";
    }

    return fullTranscript.trim();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --------------- OpenRouter LLM ---------------

function getOpenAIClient() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  return new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: key });
}

const EXTRACTION_PROMPT = `You are given a transcript from a podcast. Extract every book mentioned in it.

For each book, return a JSON object with these exact fields:
- "title": The full book title
- "author": The author's name
- "context": A 1-2 sentence summary of why or how the book was mentioned in the podcast
- "purchaseLink": A Google Books search URL built from the title and author

Return ONLY a valid JSON array of objects. If no books are found, return an empty array [].

Transcript:
`;

async function analyzeWithOpenRouter(transcriptText) {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error("OpenRouter API key is not configured. Set OPENROUTER_API_KEY in your .env file.");
  }

  const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "You are a precise data extraction assistant. Always respond with valid JSON." },
      { role: "user", content: EXTRACTION_PROMPT + transcriptText },
    ],
    response_format: { type: "json_object" },
  });

  const text = completion.choices[0].message.content;
  const parsed = JSON.parse(text);
  const books = parsed.books ?? parsed;
  return Array.isArray(books) ? books : [];
}

// --------------- Route ---------------

app.post("/api/extract", async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "A URL is required." });
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({ error: "Could not parse a valid YouTube or Apple Podcasts URL." });
  }

  try {
    let transcript;

    if (platform === "youtube") {
      // Lightweight path: grab captions directly — no audio download, no ffmpeg, no Whisper
      const videoId = extractYouTubeId(url);
      transcript = await fetchYoutubeTranscript(videoId);
    } else {
      // Heavy path: resolve RSS feed, download audio, chunk via ffmpeg, transcribe each segment
      const ids = extractApplePodcastIds(url);
      const audioUrl = await resolveApplePodcastAudioUrl(ids.showId, ids.episodeId);
      transcript = await transcribeAudioUrl(audioUrl);
    }

    if (!transcript || transcript.trim().length < 20) {
      return res.status(400).json({ error: "Transcript too short or empty — no content to analyze." });
    }

    const books = await analyzeWithOpenRouter(transcript);
    res.json({ books });
  } catch (err) {
    console.error("Extraction error:", err);

    if (err.message?.includes("Transcript is disabled")) {
      return res.status(400).json({ error: "Transcripts are disabled for this video." });
    }
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: "Failed to parse AI response. Try again." });
    }

    const known =
      err.message?.startsWith?.("iTunes") ||
      err.message?.startsWith?.("RSS") ||
      err.message?.startsWith?.("Audio download") ||
      err.message?.startsWith?.("OpenRouter") ||
      err.message?.startsWith?.("No episode") ||
      err.message?.startsWith?.("No audio") ||
      err.message?.startsWith?.("Podcast show not found") ||
      err.message?.startsWith?.("Audio URL missing") ||
      err.message?.startsWith?.("Could not find") ||
      err.message?.startsWith?.("Could not read audio duration") ||
      err.message?.startsWith?.("Audio file is too short") ||
      err.message?.startsWith?.("ffprobe failed") ||
      err.message?.startsWith?.("ffmpeg segment") ||
      err.message?.startsWith?.("Segment") ||
      err.message?.startsWith?.("Transcription request failed");
    if (known) {
      return res.status(400).json({ error: err.message });
    }

    res.status(500).json({ error: err.message || "Something went wrong." });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Podcast Book Extractor running → http://localhost:${PORT}\n`);
});