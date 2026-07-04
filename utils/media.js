// utils/media.js — Download media from WhatsApp messages
import { downloadContentFromMessage } from '@whiskeysockets/baileys';

export default async function downloadMedia(sock, msg) {
  const m = msg.message;
  if (!m) throw new Error('No message content');

  let msgType = null;
  let mediaMsg = null;

  if (m.imageMessage)       { msgType = 'image';    mediaMsg = m.imageMessage;    }
  else if (m.audioMessage)  { msgType = 'audio';    mediaMsg = m.audioMessage;    }
  else if (m.videoMessage)  { msgType = 'video';    mediaMsg = m.videoMessage;    }
  else if (m.documentMessage){ msgType = 'document'; mediaMsg = m.documentMessage; }
  else throw new Error('Unsupported media type');

  const stream = await downloadContentFromMessage(mediaMsg, msgType);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
