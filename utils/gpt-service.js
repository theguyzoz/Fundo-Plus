// utils/gpt-service.js — GPT-4O proxy service for Fundo Plus

/**
 * GPT-4O Chat via deepenglish.com proxy
 * @param {{ message?: string, systemInstruction?: string, messages?: Array, temperature?: number, max_tokens?: number }} config
 * @returns {Promise<{ success: boolean, answer?: string, error?: string }>}
 */
export async function gpt4oChat(config = {}) {
  try {
    const {
      message,
      systemInstruction = 'You are a helpful, professional assistant.',
      messages = [],
      temperature = 0.7,
      top_p = 0.7,
      top_k = 40,
      max_tokens = 512,
    } = config;

    if (!message && messages.length === 0) {
      return { success: false, error: 'No message or conversation history provided' };
    }

    const messageArray = [
      { role: 'system', content: systemInstruction },
      ...messages.filter(m => m.role !== 'system'),
    ];
    if (message) messageArray.push({ role: 'user', content: message });
    if (messageArray.length < 2) return { success: false, error: 'Insufficient messages' };

    const response = await fetch('https://api.deepenglish.com/api/gpt_open_ai/chatnew', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer UFkOfJaclj61OxoD7MnQknU1S2XwNdXMuSZA+EZGLkc=',
      },
      body: JSON.stringify({ messages: messageArray, temperature, top_p, top_k, max_tokens }),
    });

    if (!response.ok) {
      const txt = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${txt.slice(0, 100)}` };
    }

    const data = await response.json();
    if (!data?.success) return { success: false, error: 'GPT service returned failure' };

    return { success: true, answer: data.message, model: 'gpt-4o' };
  } catch (error) {
    console.error('[GPT Service] Error:', error.message);
    return { success: false, error: error.message };
  }
}

export default gpt4oChat;
