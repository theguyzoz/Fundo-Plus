// utils/speech.js — Audio transcription using AssemblyAI free tier or Whisper via HF
// Falls back gracefully if unavailable

const HF_API = 'https://api-inference.huggingface.co/models';
const HF_KEY = process.env.HF_API_KEY || '';
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY || '';

/**
 * Transcribe audio buffer to text.
 * @param {Buffer} audioBuffer
 * @returns {Promise<string|null>}
 */
export async function transcribeAudio(audioBuffer) {
  // Try Whisper via Hugging Face (free)
  try {
    const res = await fetch(`${HF_API}/openai/whisper-base`, {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/octet-stream',
        ...(HF_KEY ? { 'Authorization': `Bearer ${HF_KEY}` } : {}),
      },
      body: audioBuffer,
    });

    if (res.ok) {
      const data = await res.json();
      const text = data?.text || data?.[0]?.text;
      if (text && text.trim().length > 1) return text.trim();
    }
  } catch (err) {
    console.warn('Whisper HF transcription failed:', err.message);
  }

  return null;
}
