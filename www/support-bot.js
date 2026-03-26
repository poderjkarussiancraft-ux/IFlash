// ============================================================
// support-bot.js — Клиентская часть бота (рендер + кнопки)
//
// Отвечает ТОЛЬКО за:
//  1. Парсинг расшифрованных сообщений бота (кнопки, текст)
//  2. Отправку нажатий кнопок боту (зашифровывает __BTN__action через E2EE)
//
// Вся логика бота — в Node.js процессе bot-support/index.js
// Шифрование — в encryption.js (window.Encryption)
// ============================================================

const SupportBot = (() => {
  const SUPPORT_BOT_UID = '490b5f9b-cad0-41d3-b55e-8cc4be0d50e4';

  // ── Парсинг сообщения бота ────────────────────────────────────
  // Принимает УЖЕ РАСШИФРОВАННЫЙ контент (decryption происходит в chat.js)
  // Формат после расшифровки: __SBOT__{json}
  function parseBotMessage(content) {
    if (!content || !content.startsWith('__SBOT__')) return null;
    try { return JSON.parse(content.slice(8)); } catch { return null; }
  }

  // ── Нажатие кнопки → шифруем и шлём боту ────────────────────
  async function handleButtonAction(userId, btnAction) {
    if (!window.supabaseClient || !userId) return;

    // Контент кнопки
    const plainContent = `__BTN__${btnAction}`;

    // Шифруем если E2EE доступен
    let content = plainContent;
    if (window.Encryption) {
      try {
        content = await window.Encryption.encryptFor(plainContent, SUPPORT_BOT_UID);
      } catch (e) {
        console.warn('[SupportBot] E2EE encrypt failed, отправляем без шифрования:', e.message);
      }
    }

    const { error } = await window.supabaseClient.from('messages').insert({
      sender_id:   userId,
      receiver_id: SUPPORT_BOT_UID,
      content,
    });

    if (error) console.error('[SupportBot] button send error:', error.message);
  }

  function isSupportBot(userId) { return userId === SUPPORT_BOT_UID; }
  function getBotUid()           { return SUPPORT_BOT_UID; }
  function init()                { /* UID жёстко прописан */ }

  return {
    init,
    isSupportBot,
    getBotUid,
    parseBotMessage,
    handleButtonAction,
    SUPPORT_BOT_UID,
  };
})();

window.SupportBot = SupportBot;
