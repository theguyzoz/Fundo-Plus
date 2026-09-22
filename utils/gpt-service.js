// utils/gpt-service.js - GPT-OSS-120B service

/**
 * GPT-OSS-120B Chat
 * @param {{
 *   message?: string,
 *   messages?: Array,
 *   temperature?: number,
 *   max_tokens?: number
 * }} config
 * @returns {Promise<{ success: boolean, answer?: string, error?: string, model?: string }>}
 */
export async function gpt4oChat(config = {}) {
  try {
    const {
      message,
      messages = [],
      temperature = 0.7,
      top_p = 0.7,
      top_k = 40,
      max_tokens = 512,
    } = config;

    if (!message && messages.length === 0) {
      return {
        success: false,
        error: 'No message or conversation history provided',
      };
    }

    // No system/AI instruction.
    const messageArray = [
      ...messages.filter(m => m.role !== 'system'),
    ];

    if (message) {
      messageArray.push({
        role: 'user',
        content: message,
      });
    }

    if (messageArray.length === 0) {
      return {
        success: false,
        error: 'Insufficient messages',
      };
    }

    const response = await fetch(
      'https://openai.junioralive.workers.dev/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://ish.chat',
          'Referer': 'https://ish.chat/',
          'User-Agent': 'Mozilla/5.0',
          'x-proxy-key':
            'ish-7f9e2c1b-5c8a-4b0f-9a7d-1e5c3b2a9f74',
        },
        body: JSON.stringify({
          model: 'gpt-oss-120b',
          messages: messageArray,
          temperature,
          top_p,
          top_k,
          max_tokens,
          stream: false,
        }),
      }
    );

    if (!response.ok) {
      const txt = await response.text();

      return {
        success: false,
        error: `HTTP ${response.status}: ${txt.slice(0, 200)}`,
      };
    }

    const data = await response.json();

    const answer = data?.choices?.[0]?.message?.content;

    if (!answer) {
      return {
        success: false,
        error: 'GPT-OSS service returned no response',
      };
    }

    return {
      success: true,
      answer,
      model: 'gpt-oss-120b',
    };
  } catch (error) {
    console.error('[GPT Service] Error:', error.message);

    return {
      success: false,
      error: error.message,
    };
  }
}

export default gpt4oChat;
