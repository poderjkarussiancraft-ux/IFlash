// ============================================================
// chat.js — Логика сообщений, поиска и Realtime-обновлений
// ============================================================

const Chat = (() => {
  // ---- Определение устройства ----
  const _isMobile = /Android|iPhone|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
  const _isTablet = /iPad|Android(?!.*Mobile)/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth >= 600 && window.innerWidth <= 1024);
  const _isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const _isDesktop = !_isMobile && !_isTablet;
  const _isAndroid = /Android/i.test(navigator.userAgent);
  const _isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // Устанавливаем data-атрибуты на body для CSS-адаптации
  (function applyDeviceClass() {
    const b = document.body;
    if (_isMobile) { b.setAttribute('data-device', 'mobile'); b.classList.add('is-mobile'); }
    else if (_isTablet) { b.setAttribute('data-device', 'tablet'); b.classList.add('is-tablet'); }
    else { b.setAttribute('data-device', 'desktop'); b.classList.add('is-desktop'); }
    if (_isTouchDevice) b.classList.add('is-touch');
    // Отключаем тяжёлые эффекты на Android для производительности
    if (_isAndroid || _isCapacitor) b.classList.add('is-android');

    // Устанавливаем CSS-переменную для реальной высоты viewport (без адресной строки)
    function setVH() {
      // Используем visualViewport если доступен — даёт правильный размер при открытой клавиатуре
      const h = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
      document.documentElement.style.setProperty('--vh', (h * 0.01) + 'px');
    }
    setVH();
    window.addEventListener('resize', setVH);
    window.addEventListener('orientationchange', () => setTimeout(setVH, 150));
    if (window.visualViewport) {
      // visualViewport.resize срабатывает при открытии/закрытии клавиатуры на мобильных
      window.visualViewport.addEventListener('resize', () => {
        setVH();
        // После закрытия клавиатуры сбрасываем скролл страницы чтобы не оставалась белая полоса
        setTimeout(() => { window.scrollTo(0, 0); }, 50);
      });
    }

    // На мобильных при фокусе на поле ввода — скроллим чат вниз и фиксим viewport
    if (_isMobile || _isTablet) {
      document.addEventListener('focusin', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
          setTimeout(() => {
            // Обновляем --vh чтобы учесть клавиатуру
            setVH();
            // Скроллим страницу вверх чтобы input-area не уехала за клавиатуру
            window.scrollTo(0, 0);
            // Скроллим сообщения вниз
            const mc = document.getElementById('messages-container');
            if (mc) mc.scrollTop = mc.scrollHeight;
          }, 300);
        }
      });
    }
  })();

  // ---- Состояние ----
  let currentUser = null;           // Текущий авторизованный пользователь
  let currentProfile = null;        // Профиль текущего пользователя
  let selectedChat = null;          // Выбранный собеседник (объект профиля)
  let realtimeSubscription = null;  // Подписка на Realtime
  let groupsRealtimeSub = null;     // Подписка на изменения таблицы groups (аватарки, названия)
  let allProfiles = [];             // Список всех профилей для поиска
  let _profilesMap = new Map();    // Быстрый поиск профиля по id (O(1) vs O(n))
  // Добавить/обновить профиль в кеш
  function _cacheProfile(p) {
    if (!p || !p.id) return;
    if (!_profilesMap.has(p.id)) allProfiles.push(p);
    _profilesMap.set(p.id, p);
  }
  function _cacheProfiles(arr) {
    if (!arr) return;
    arr.forEach(_cacheProfile);
  }
  let conversationsList = [];       // Список диалогов пользователя
  const manuallyUnreadUsers = new Set(); // Вручную помеченные как непрочитанные
  let searchTimer = null;           // Таймер для отложенного поиска
  let selectedFile = null;          // Выбранный для отправки файл (одиночный, для обратной совместимости)
  let selectedFiles = [];           // Массив выбранных файлов (поддержка нескольких фото)
  let isSettingsOpen = false;       // Открыта ли панель настроек
  let currentWallpaper = 'none';    // Текущие обои чата
  let currentTheme = 'dark';        // Текущая тема
  const renderedMessageIds = new Set(); // Защита от дублирования сообщений в UI
  let listenersInitialized = false; // Защита от повторной навески слушателей
  let _initGeneration = 0;          // Счётчик поколений init — защита от гонки быстрый вход/выход
  let _chatLoadGen = 0;             // Счётчик поколений загрузки чата — защита от race condition при быстром переключении

  // ---- Пагинация сообщений ----
  const PAGE_SIZE = 30;             // Сколько сообщений грузить за раз
  let paginationPartnerId = null;   // ID собеседника при текущей пагинации
  let oldestMsgDate = null;         // created_at самого старого загруженного сообщения
  let isLoadingMore = false;        // Флаг: идёт ли подгрузка
  let hasMoreMessages = true;       // Есть ли ещё сообщения выше
  let topObserver = null;           // IntersectionObserver для sentinel-элемента

  // ---- Поиск в чате ----
  let msgSearchActive = false;      // Открыта ли строка поиска
  let msgSearchQuery = '';          // Текущий поисковый запрос
  let msgSearchTimer = null;        // Debounce таймер

  // ---- Поиск (в боковой панели) ----
  let isSearchMode = false;         // Показываем ли результаты поиска вместо диалогов
  let searchModeResults = [];       // Результаты поиска по пользователям (username)
  let searchMsgResults = [];        // Результаты поиска по тексту в личных чатах
  let searchGroupMsgResults = [];   // Результаты поиска по тексту в группах
  let searchCurrentQuery = '';      // Текущий запрос (для подсветки совпадений)

  // ---- Черновики сообщений ----
  // Ключ: "user_<userId>" | "group_<groupId>" | "channel_<channelId>"
  const draftsMap = {};
  let draftSidebarTimer = null;     // Debounce для обновления превью в сайдбаре

  function getDraftKey() {
    if (selectedGroup) return `group_${selectedGroup.id}`;
    if (selectedChat)  return `user_${selectedChat.id}`;
    // Канал (только для админа, у которого виден #message-input)
    const ch = window.Channels && window.Channels.selectedChannel;
    if (ch) return `channel_${ch.id}`;
    return null;
  }

  function restoreDraftForCurrentChat() {
    const key = getDraftKey();
    const input = getEl('message-input');
    if (!input) return;
    input.value = (key && draftsMap[key]) ? draftsMap[key] : '';
    input.style.height = 'auto';
    if (input.value) input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    updateSendBtnVisibility();
  }

  function clearDraftForCurrentChat() {
    const key = getDraftKey();
    if (key) delete draftsMap[key];
  }

  // Обновить превью черновика в сайдбаре для текущего чата
  function updateDraftPreviewInSidebar() {
    const key = getDraftKey();
    if (!key) return;
    let sidebarEl = null;
    if (selectedGroup) {
      sidebarEl = document.querySelector(`.conversation-item[data-group-id="${selectedGroup.id}"] .conv-text`);
    } else if (selectedChat) {
      sidebarEl = document.querySelector(`.conversation-item[data-user-id="${selectedChat.id}"] .conv-text`);
    }
    if (!sidebarEl) return;
    const draft = draftsMap[key];
    if (draft && draft.trim()) {
      const preview = draft.length > 32 ? draft.slice(0, 32) + '…' : draft;
      sidebarEl.innerHTML = `<span class="draft-label">Черновик:</span> ${escapeHTML(preview)}`;
    }
  }

  // ---- WebRTC Звонки ----
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: [
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:443',
        'turn:global.relay.metered.ca:443?transport=tcp',
      ],
      username: '5dd98373116bb87495e88f85',
      credential: '84haHJY3QwpJ/3tx',
    },
  ];
  let activePeerConnection = null;
  let activeLocalStream = null;
  let activeCallId = null;
  let activeCallUserId = null;
  let callSignalSub = null;
  let isCallInitiator = false;
  let callRingInterval = null;
  let callTimerInterval = null;
  let callDurationSec = 0;

  // ---- Антифлуд ----
  // Глобальный: работает во всех чатах, 3 сообщения за 3 секунды
  const FLOOD_LIMIT = 3;            // макс сообщений
  const FLOOD_WINDOW = 3000;        // окно в мс
  let floodTimestamps = [];         // метки времени отправок
  let floodCooldownTimer = null;    // таймер снятия блокировки
  let isFloodBlocked = false;       // заблокирована ли отправка

  // ---- Палитра реакций ----
  // Только человеческие эмодзи, сгруппированы по смыслу
  const ALL_EMOJI = [
    // Лица и эмоции
    '😀','😃','😄','😁','😆','😅','🤣','😂',
    '🙂','🙃','😉','😊','😇','🥰','😍','🤩',
    '😘','😗','😚','😙','🥲','😋','😛','😜',
    '🤪','😝','🤑','🤗','🤭','🫢','🫣','🤫',
    '🤔','🫡','🤐','🤨','😐','😑','😶','🫥',
    '😏','😒','🙄','😬','🤥','🫨','😌','😔',
    '😪','🤤','😴','😷','🤒','🤕','🤢','🤧',
    '🥵','🥶','🥴','😵','🤯','🤠','🥸','😎',
    '🤓','🧐','😕','🫤','😟','🙁','☹️','😮',
    '😯','😲','😳','🥺','🥹','😦','😧','😨',
    '😰','😥','😢','😭','😱','😖','😣','😞',
    '😓','😩','😫','🥱','😤','😡','😠','🤬',
    '😈','👿','💀','☠️','💩','🤡','👹','👺',
    '👻','👽','🤖','😺','😸','😹','😻','😼',
    '😽','🙀','😿','😾',
    // Жесты и руки
    '👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳',
    '🫴','🫵','👌','🤌','🤏','✌️','🤞','🫰',
    '🤟','🤘','🤙','👈','👉','👆','🖕','👇',
    '☝️','👍','👎','✊','👊','🤛','🤜','👏',
    '🙌','🫶','👐','🤲','🤝','🙏','✍️','💅',
    '🤳','💪','🦾','🦵','🦶','👂','🦻','👃',
    '🫀','🫁','🧠','🦷','🦴','👁️','👅','👄',
    // Люди и тела
    '🧑','👦','👧','🧒','👶','🧓','👴','👵',
    '👱','👨','🧔','👩','🧑‍🦱','👨‍🦱','👩‍🦱',
    '🧑‍🦰','👨‍🦰','👩‍🦰','🧑‍🦳','👨‍🦳','👩‍🦳',
    '🧑‍🦲','👨‍🦲','👩‍🦲','🧕','🤱','👼',
    '🎅','🤶','🦸','🦹','🧙','🧝','🧛','🧟',
    '🧞','🧜','🧚','🧑‍🦯','👫','👬','👭','💑',
    '👨‍👩‍👦','👨‍👩‍👧','🙋','🙆','🙅','💁','🙎',
    '🙍','🤦','🤷','💆','💇','🚶','🧍','🧎',
    '🏃','💃','🕺','🧖','🛀','🧑‍🤝‍🧑',
    // Сердца и символы любви
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍',
    '🤎','💔','❤️‍🔥','❤️‍🩹','💕','💞','💓',
    '💗','💖','💘','💝','💟','☮️','🫶',
  ];
  // Первые 4 — быстрые (всегда видны)
  const QUICK_EMOJI = ALL_EMOJI.slice(0, 4);

  // Хранилище реакций: { msgId: { emoji: [userId, ...] } }
  let reactionsCache = {};
  // Подписка на реакции
  let reactionsSubscription = null;
  // Подписка на изменения профилей (аватарки, имена, last_seen всех пользователей)
  let profilesRealtimeSub = null;

  const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 МБ
  const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5 МБ

  // ---- Голосовые сообщения ----
  let mediaRecorder = null;
  let audioChunks = [];
  let voiceStartTime = null;
  let voiceDuration = 0;
  let voiceTimerInterval = null;
  let _tokenRefreshInterval = null;
  let voiceBlob = null;
  let presenceSubscription = null;
  let lastSeenInterval = null;
  let _callMuted = false;
  let _callMicAnalyser = null;
  let _callMicAnimFrame = null;
  // ---- «Цифровая вежливость» ----
  let sendWhenOnlineMode = false;
  let pendingOnlineMessages = []; // { local_id, content, file_url, file_name, file_type, file_size, partner_id }
  let sendWhenOnlinePresenceSub = null;
  const MAX_VOICE_DURATION = 5 * 60 * 1000; // 5 минут

  // ---- Видеокружки (видеонотки) ----
  let vidnoteRecorder = null;
  let vidnoteChunks = [];
  let vidnoteStream = null;
  let vidnoteStartTime = null;
  let vidnoteTimerInterval = null;
  let vidnoteBlob = null;
  let vidnoteDuration = 0;
  let _currentVidnoteUid = null;
  const MAX_VIDNOTE_DURATION = 60 * 1000; // 60 секунд

  // ---- Система блокировок ----
  let blockedUsers = new Set();   // Set userId-ов, которых заблокировал текущий пользователь
  let trustedUsers = new Set();   // Set userId-ов, которые добавлены в контакты (мной)
  let theyAddedMe = new Set();    // Set userId-ов, которые добавили меня в контакты
  let removedContacts = new Set(); // Set userId-ов, которых явно удалили из контактов (баннер незнакомца вернётся)

  // ---- Настройки приватности (безопасность) ----
  // who_can_message: 'all' | 'contacts'
  // who_can_call:    'all' | 'contacts'
  // protected_mode:  boolean (быстрый тумблер = contacts для обоих)
  let privacySettings = {
    who_can_message: 'all',
    who_can_call: 'all',
    protected_mode: false,
  };

  function loadPrivacySettings() {
    try {
      const raw = localStorage.getItem(_lsKey('iflash_privacy'));
      if (raw) privacySettings = { ...privacySettings, ...JSON.parse(raw) };
    } catch {}
  }
  function savePrivacySettings() {
    localStorage.setItem(_lsKey('iflash_privacy'), JSON.stringify(privacySettings));
    // Также сохраняем в Supabase для проверки другими пользователями
    if (currentUser) {
      window.supabaseClient.from('profiles').update({
        privacy_settings: JSON.stringify(privacySettings)
      }).eq('id', currentUser.id).then(() => {});
    }
  }

  // ============================================================
  // ---- E2EE: статус и сброс ключей ----
  // ============================================================

  function _updateE2eeStatusUI(ok) {
    const el = document.getElementById('e2ee-status-text');
    if (!el) return;
    const hasKey = window.Encryption && window.Encryption.getMyPublicKeyB64();
    if (ok === false || !hasKey) {
      el.textContent = '❌ Ключ не загружен — нажмите «Перезагрузить»';
      el.style.color = '#ef4444';
    } else {
      const keyShort = window.Encryption.getMyPublicKeyB64()?.slice(0, 16) + '…';
      el.textContent = `✅ Ключ активен: ${keyShort}`;
      el.style.color = '#22c55e';
    }
  }

  // Принудительно перезагрузить E2EE ключ без сброса (пробует облако снова)
  async function reloadE2eeKey() {
    if (!window.Encryption || !currentUser) return;
    showToast('Перезагружаем ключ шифрования…', 'info');
    try {
      await window.Encryption.initUser(currentUser.id);
      _updateE2eeStatusUI();
      if (window.Encryption.getMyPublicKeyB64()) {
        showToast('✅ Ключ E2EE успешно загружен', 'success');
        // Переоткрываем текущий чат чтобы расшифровать сообщения
        if (selectedChat) await loadMessages(selectedChat.id);
        else if (selectedGroup) await loadGroupMessages(selectedGroup.id);
      } else {
        showToast('❌ Ключ не удалось загрузить. Примените SQL в Supabase.', 'error');
      }
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  function confirmResetE2EE() {
    if (!window.Encryption || !currentUser) return;
    // Простой confirm — потом можно заменить на кастомный модал
    const ok = window.confirm(
      '⚠️ Сбросить ключ E2EE?\n\n' +
      'Будет создана новая ключевая пара.\n' +
      'Все предыдущие зашифрованные сообщения станут нечитаемы.\n\n' +
      'Продолжить?'
    );
    if (!ok) return;
    showToast('Создаём новый ключ…', 'info');
    window.Encryption.resetKeys(currentUser.id).then(() => {
      _updateE2eeStatusUI();
      const key = window.Encryption.getMyPublicKeyB64();
      if (key) {
        showToast('🔑 Ключ E2EE пересоздан', 'success');
      } else {
        showToast('⚠️ Ключ создан локально, но не сохранён в облако — нужен SQL в Supabase', 'error');
      }
    }).catch(e => {
      showToast('Ошибка сброса ключа: ' + e.message, 'error');
    });
  }

  function toggleProtectedMode() {
    const toggle = getEl('protected-mode-toggle');
    privacySettings.protected_mode = toggle ? toggle.checked : !privacySettings.protected_mode;
    if (privacySettings.protected_mode) {
      privacySettings.who_can_message = 'contacts';
      privacySettings.who_can_call = 'contacts';
    } else {
      privacySettings.who_can_message = 'all';
      privacySettings.who_can_call = 'all';
    }
    savePrivacySettings();
    renderSecurityPage();
  }

  function setPrivacySetting(key, value) {
    privacySettings[key] = value;
    // Обновляем protected_mode если оба стали contacts
    privacySettings.protected_mode = (privacySettings.who_can_message === 'contacts' && privacySettings.who_can_call === 'contacts');
    savePrivacySettings();
    renderSecurityPage();
  }

  function renderSecurityPage() {
    const toggle = getEl('protected-mode-toggle');
    if (toggle) toggle.checked = privacySettings.protected_mode;

    const desc = getEl('protected-mode-desc');
    if (desc) desc.classList.toggle('active', privacySettings.protected_mode);

    const isProtected = privacySettings.protected_mode;

    // Обновляем радио-кнопки кто может писать + блокируем если защищённый режим
    document.querySelectorAll('input[name="who-can-message"]').forEach(r => {
      r.checked = r.value === privacySettings.who_can_message;
      r.disabled = isProtected;
    });
    document.querySelectorAll('input[name="who-can-call"]').forEach(r => {
      r.checked = r.value === privacySettings.who_can_call;
      r.disabled = isProtected;
    });

    // Визуально блокируем группы radio
    const msgGroup = document.querySelector('#page-security .security-select-group:first-of-type');
    const callGroup = document.querySelector('#page-security .security-select-group:last-of-type');
    const allGroups = document.querySelectorAll('#page-security .security-select-group');
    allGroups.forEach(g => g.classList.toggle('disabled', isProtected));
  }

  // Проверяет, может ли currentUser написать targetUserId
  // Возвращает null если можно, строку с ошибкой если нельзя
  async function checkPrivacyForMessage(targetUserId) {
    if (!targetUserId || !currentUser) return null;
    if (targetUserId === currentUser.id) return null;

    try {
      // Загружаем настройки приватности получателя
      const { data: targetProfile } = await window.supabaseClient
        .from('profiles')
        .select('privacy_settings')
        .eq('id', targetUserId)
        .maybeSingle();

      if (!targetProfile || !targetProfile.privacy_settings) return null;

      let targetPrivacy;
      try { targetPrivacy = JSON.parse(targetProfile.privacy_settings); } catch { return null; }

      const whoCanMsg = targetPrivacy.who_can_message || 'all';
      if (whoCanMsg === 'all') return null;
      if (whoCanMsg === 'contacts') {
        // Проверяем, добавил ли получатель нас в контакты
        const { data: contactRecord } = await window.supabaseClient
          .from('contacts')
          .select('owner_id')
          .eq('owner_id', targetUserId)
          .eq('contact_id', currentUser.id)
          .maybeSingle();
        if (!contactRecord) {
          return 'Этот пользователь принимает сообщения только от контактов. Вы не в его списке контактов.';
        }
      }
    } catch (err) {
      console.warn('[Privacy check error]', err);
    }
    return null;
  }

  // Проверяет, может ли currentUser позвонить targetUserId
  async function checkPrivacyForCall(targetUserId) {
    if (!targetUserId || !currentUser) return null;
    if (targetUserId === currentUser.id) return null;

    try {
      const { data: targetProfile } = await window.supabaseClient
        .from('profiles')
        .select('privacy_settings')
        .eq('id', targetUserId)
        .maybeSingle();

      if (!targetProfile || !targetProfile.privacy_settings) return null;

      let targetPrivacy;
      try { targetPrivacy = JSON.parse(targetProfile.privacy_settings); } catch { return null; }

      const whoCanCall = targetPrivacy.who_can_call || 'all';
      if (whoCanCall === 'all') return null;
      if (whoCanCall === 'contacts') {
        // Проверяем с двух сторон: либо они добавили нас, либо мы добавили их
        const [{ data: theyHaveUs }, { data: weHaveThem }] = await Promise.all([
          window.supabaseClient.from('contacts').select('owner_id')
            .eq('owner_id', targetUserId).eq('contact_id', currentUser.id).maybeSingle(),
          window.supabaseClient.from('contacts').select('owner_id')
            .eq('owner_id', currentUser.id).eq('contact_id', targetUserId).maybeSingle(),
        ]);
        if (!theyHaveUs && !weHaveThem) {
          return 'Этот пользователь принимает звонки только от контактов.';
        }
      }
    } catch (err) {
      console.warn('[Privacy check error]', err);
    }
    return null;
  }

  // ---- Кастомные имена и аватарки контактов ----
  // Хранятся локально: { userId: { name?: string, avatar?: string } }
  let contactOverrides = {};
  function loadContactOverrides() {
    try {
      const raw = localStorage.getItem(_lsKey('iflash_contact_overrides'));
      contactOverrides = raw ? JSON.parse(raw) : {};
    } catch { contactOverrides = {}; }
  }
  function saveContactOverrides() {
    localStorage.setItem(_lsKey('iflash_contact_overrides'), JSON.stringify(contactOverrides));
  }
  function getContactDisplayName(profile) {
    if (!profile) return '?';
    const ov = contactOverrides[profile.id];
    if (ov && ov.name && ov.name.trim()) return ov.name.trim();
    return getDisplayName(profile);
  }
  function getContactAvatarHTML(profile, size = 40) {
    if (!profile) return getAvatarHTML(null, size);
    const ov = contactOverrides[profile.id];
    if (ov && ov.avatar) {
      return `<img src="${ov.avatar}" alt="" class="avatar-img" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;cursor:pointer;" onclick="Chat.openImageModal('${ov.avatar}')">`;
    }
    return getAvatarHTML(profile, size);
  }

  // Ключи localStorage привязаны к userId — у каждого аккаунта своё хранилище
  function _lsKey(base) { return `${base}_${currentUser?.id || 'anon'}`; }

  async function loadBlockedUsers() {
    // Сначала из localStorage (ключи привязаны к userId)
    try {
      const raw = localStorage.getItem(_lsKey('iflash_blocked'));
      blockedUsers = new Set(raw ? JSON.parse(raw) : []);
      const rawT = localStorage.getItem(_lsKey('iflash_trusted'));
      trustedUsers = new Set(rawT ? JSON.parse(rawT) : []);
      const rawR = localStorage.getItem(_lsKey('iflash_removed_contacts'));
      removedContacts = new Set(rawR ? JSON.parse(rawR) : []);
    } catch { blockedUsers = new Set(); trustedUsers = new Set(); removedContacts = new Set(); }

    // Потом синхронизируем из Supabase (если таблица существует)
    try {
      const { data } = await window.supabaseClient
        .from('user_blocks')
        .select('blocked_id')
        .eq('blocker_id', currentUser.id);
      if (data) {
        data.forEach(row => blockedUsers.add(row.blocked_id));
        saveBlockedUsers(); // синхронизируем localStorage
      }
    } catch {
      // Таблица user_blocks не существует — работаем только с localStorage
    }
  }

  function saveBlockedUsers() {
    localStorage.setItem(_lsKey('iflash_blocked'), JSON.stringify([...blockedUsers]));
    localStorage.setItem(_lsKey('iflash_trusted'), JSON.stringify([...trustedUsers]));
    localStorage.setItem(_lsKey('iflash_removed_contacts'), JSON.stringify([...removedContacts]));
  }

  // ---- Контакты: синхронизация с Supabase ----
  async function syncContactsWithServer() {
    if (!currentUser) return;
    try {
      // Кого я добавил (RLS разрешает читать свои строки — owner_id = auth.uid())
      const { data: myContacts } = await window.supabaseClient
        .from('contacts')
        .select('contact_id')
        .eq('owner_id', currentUser.id);
      if (myContacts) {
        // Перезаписываем trustedUsers данными из БД (источник истины)
        const serverTrusted = new Set(myContacts.map(r => r.contact_id));
        trustedUsers = serverTrusted;
        // Убираем из removedContacts тех, кого снова добавили
        removedContacts.forEach(id => {
          if (trustedUsers.has(id)) removedContacts.delete(id);
        });
        saveBlockedUsers();
      }

      // Кто добавил меня — нужен SECURITY DEFINER RPC чтобы обойти RLS
      // (прямой запрос к чужим строкам будет заблокирован политикой)
      const { data: theirData, error: rpcErr } = await window.supabaseClient
        .rpc('get_who_added_me');
      if (!rpcErr && theirData) {
        theyAddedMe = new Set(theirData.map(r => r.owner_id));
      } else if (rpcErr) {
        console.warn('[Contacts] get_who_added_me RPC недоступна, запусти fix_contacts_rls.sql:', rpcErr.message);
        // Fallback: пробуем прямой запрос (работает если RLS не включён)
        const { data: fallback } = await window.supabaseClient
          .from('contacts')
          .select('owner_id')
          .eq('contact_id', currentUser.id);
        if (fallback) theyAddedMe = new Set(fallback.map(r => r.owner_id));
      }
    } catch (e) {
      console.warn('[Contacts] syncContactsWithServer error:', e);
    }
  }

  // Проверка: является ли контакт взаимным (оба добавили друг друга)
  function isMutualContact(userId) {
    return trustedUsers.has(userId) && theyAddedMe.has(userId);
  }

  async function addContact(userId) {
    if (!currentUser || trustedUsers.has(userId)) return;
    trustedUsers.add(userId);
    removedContacts.delete(userId); // снимаем метку "удалён"
    saveBlockedUsers();
    try {
      await window.supabaseClient
        .from('contacts')
        .insert({ owner_id: currentUser.id, contact_id: userId });
    } catch { /* ок если таблицы нет */ }
    showToast('Добавлен в контакты', 'success');
    renderContactsList();
  }

  async function removeContact(userId) {
    trustedUsers.delete(userId);
    removedContacts.add(userId); // чтобы баннер незнакомца вернулся при открытии чата
    saveBlockedUsers();
    try {
      await window.supabaseClient
        .from('contacts')
        .delete()
        .eq('owner_id', currentUser.id)
        .eq('contact_id', userId);
    } catch { /* ок */ }
    renderContactsList();
    showToast('Удалён из контактов', 'info');
  }

  function renderContactsList() {
    const listEl = getEl('contacts-list');
    if (!listEl) return;
    const ids = [...trustedUsers];
    if (ids.length === 0) {
      listEl.innerHTML = '<div class="contacts-empty">Контактов пока нет</div>';
      return;
    }
    const profiles = allProfiles.filter(p => ids.includes(p.id));
    if (profiles.length === 0) {
      listEl.innerHTML = '<div class="contacts-empty">Загрузка...</div>';
      return;
    }
    listEl.innerHTML = profiles.map(p => {
      const isMutual = theyAddedMe.has(p.id);
      const mutualBadge = isMutual
        ? '<span class="contact-mutual-badge">взаимный</span>'
        : '<span class="contact-one-sided-badge">односторонний</span>';
      return `
      <div class="contact-row" data-uid="${p.id}">
        <div class="contact-row-avatar-wrap" onclick="Chat.openContactEditModal('${p.id}')" title="Изменить">
          ${getContactAvatarHTML(p, 40)}
        </div>
        <div class="contact-row-info" onclick="Chat.openChatWithUser('${p.id}')" style="cursor:pointer;">
          <div class="contact-row-name">${escapeHTML(getContactDisplayName(p))}${p.username !== getContactDisplayName(p) ? `<span class="contact-custom-name-mark">✎</span>` : ''}</div>
          <div class="contact-row-handle">@${escapeHTML(p.username)} ${mutualBadge}</div>
        </div>
        <button class="contact-edit-btn" onclick="Chat.openContactEditModal('${p.id}')" title="Редактировать">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="contact-remove-btn" onclick="Chat.removeContact('${p.id}')" title="Удалить из контактов">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `}).join('');
  }

  // ---- Модальное окно редактирования контакта ----
  function openContactEditModal(userId) {
    const profile = allProfiles.find(p => p.id === userId);
    if (!profile) return;
    const existing = document.getElementById('contact-edit-modal');
    if (existing) existing.remove();
    const ov = contactOverrides[userId] || {};
    const currentName = ov.name || getDisplayName(profile);
    const currentAvatar = ov.avatar || profile.avatar_url || '';

    const modal = document.createElement('div');
    modal.id = 'contact-edit-modal';
    modal.className = 'contact-edit-modal-overlay';
    modal.innerHTML = `
      <div class="contact-edit-modal-box">
        <div class="cem-header">
          <span class="cem-title">Редактировать контакт</span>
          <button class="cem-close" onclick="document.getElementById('contact-edit-modal').remove()">✕</button>
        </div>
        <div class="cem-avatar-wrap" onclick="document.getElementById('cem-avatar-input').click()" title="Сменить фото">
          <img id="cem-avatar-preview" src="${currentAvatar || ''}" class="cem-avatar-img" style="display:${currentAvatar ? 'block' : 'none'}">
          <div id="cem-avatar-placeholder" class="cem-avatar-placeholder" style="display:${currentAvatar ? 'none' : 'flex'}">
            ${getAvatarHTML(profile, 72)}
          </div>
          <div class="cem-avatar-overlay">📷</div>
          <input type="file" id="cem-avatar-input" accept="image/*" style="display:none" onchange="Chat._cemAvatarChange(event,'${userId}')">
        </div>
        <div class="cem-orig-name">Имя в профиле: <b>${escapeHTML(getDisplayName(profile))}</b></div>
        <label class="cem-label">Имя контакта (ваше название)</label>
        <input id="cem-name-input" class="cem-name-input" type="text" value="${escapeHTML(currentName)}" placeholder="${escapeHTML(getDisplayName(profile))}" maxlength="40">
        <div class="cem-actions">
          <button class="cem-btn-reset" onclick="Chat._cemReset('${userId}')">Сбросить</button>
          <button class="cem-btn-save" onclick="Chat._cemSave('${userId}')">Сохранить</button>
        </div>
      </div>
    `;
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }

  async function _cemAvatarChange(e, userId) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Файл слишком большой (макс 5МБ)', 'error'); return; }
    // Сильно сжимаем — хранится в localStorage как base64
    const compressed = await compressImage(file, {
      maxSizeMB: 0.05,       // 50 KB max
      maxWidthOrHeight: 220, // достаточно для отображения аватарки
      initialQuality: 0.72,
      fileType: 'image/jpeg',
    });
    const reader = new FileReader();
    reader.onload = (ev) => {
      const preview = document.getElementById('cem-avatar-preview');
      const placeholder = document.getElementById('cem-avatar-placeholder');
      if (preview) { preview.src = ev.target.result; preview.style.display = 'block'; }
      if (placeholder) placeholder.style.display = 'none';
      // Сохраняем временно в атрибуте
      if (preview) preview.dataset.newAvatar = ev.target.result;
    };
    reader.readAsDataURL(compressed);
  }

  function _cemSave(userId) {
    const nameInput = document.getElementById('cem-name-input');
    const preview = document.getElementById('cem-avatar-preview');
    const name = nameInput ? nameInput.value.trim() : '';
    const newAvatar = preview ? (preview.dataset.newAvatar || preview.src) : '';
    if (!contactOverrides[userId]) contactOverrides[userId] = {};
    if (name) contactOverrides[userId].name = name;
    else delete contactOverrides[userId].name;
    if (newAvatar && newAvatar.startsWith('data:')) {
      contactOverrides[userId].avatar = newAvatar;
    }
    saveContactOverrides();
    document.getElementById('contact-edit-modal')?.remove();
    // Обновляем все части UI, где отображается имя/аватар контакта
    renderContactsList();
    renderConversations();
    // Если сейчас открыт чат с этим контактом — перерисовываем шапку
    if (selectedChat && selectedChat.id === userId) {
      renderChatHeader(selectedChat);
    }
    showToast('Контакт обновлён', 'success');
  }

  function _cemReset(userId) {
    delete contactOverrides[userId];
    saveContactOverrides();
    document.getElementById('contact-edit-modal')?.remove();
    renderContactsList();
    renderConversations();
    if (selectedChat && selectedChat.id === userId) {
      renderChatHeader(selectedChat);
    }
    showToast('Имя и фото сброшены', 'info');
  }

  // Текущая версия приложения
  const APP_VERSION = '1.0.3';

  // UID единственного разработчика
  const DEV_UID = 'd63a5c32-8b98-4016-ae29-07a5480c00c0';

  // Бот удалён

  // ============================================================
  // СТАТУС СООБЩЕНИЯ: галочки доставки/прочтения
  // ============================================================
  // 'sending'   → 1 серая галочка  (оптимистично, до ответа сервера)
  // 'delivered' → 2 серые галочки  (доставлено, не прочитано)
  // 'read'      → 2 синие галочки  (прочитано)
  function msgTickHTML(status) {
    const blue = '#3b82f6';
    const grey = 'var(--text-muted, #9ca3af)';
    if (status === 'sending') {
      return `<span class="msg-read-status msg-tick-sending" title="Отправляется" aria-label="Отправляется"><svg width="11" height="9" viewBox="0 0 11 9" fill="none" style="display:block;pointer-events:none;user-select:none;"><path d="M1 4.5L4 7.5L10 1" stroke="${grey}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
    }
    const color = status === 'read' ? blue : grey;
    const title = status === 'read' ? 'Прочитано' : 'Доставлено';
    return `<span class="msg-read-status msg-tick-${status}" title="${title}" aria-label="${title}"><svg width="16" height="9" viewBox="0 0 16 9" fill="none" style="display:block;pointer-events:none;user-select:none;"><path d="M1 4.5L4 7.5L10 1" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 4.5L9 7.5L15 1" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  }

  // Бейдж разработчика: единый анимированный значок — звезда с галочкой
  function devBadgeHTML() {
    return `
      <span class="dev-badge-wrap" aria-label="Разработчик">
        <svg class="dev-badge-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path class="dev-badge-star" d="M12 1L14.68 5.53L19.78 4.22L18.47 9.32L23 12L18.47 14.68L19.78 19.78L14.68 18.47L12 23L9.32 18.47L4.22 19.78L5.53 14.68L1 12L5.53 9.32L4.22 4.22L9.32 5.53Z"/>
          <path d="M8.8 12.2L11 14.5L15.5 9.5" stroke="rgba(255,255,255,0.95)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="dev-tooltip">⚡ Разработчик</span>
      </span>
    `;
  }

  // Бейдж официального бота: вращающийся контур другой формы + иконка робота
  function botBadgeHTML() {
    return `
      <span class="bot-badge-wrap" aria-label="Официальный бот">
        <!-- Вращающийся контур — скруглённый восьмиугольник -->
        <svg class="bot-badge-ring" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 2 L13.5 3.5 L16.5 6.5 L18 10 L16.5 13.5 L13.5 16.5 L10 18 L6.5 16.5 L3.5 13.5 L2 10 L3.5 6.5 L6.5 3.5 Z"
            fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
        </svg>
        <!-- Иконка робота — статичная -->
        <span class="bot-badge-icon">🤖</span>
        <span class="bot-tooltip">🤖 Официальный бот</span>
      </span>
    `;
  }

  // UID спонсоров
  const SPONSOR_UIDS = new Set([
    '6fa63114-bf01-4650-8bd2-02e8d9d6a589',
  ]);

  // Бейдж спонсора: золотой бриллиант с пульсирующим свечением
  function sponsorBadgeHTML() {
    return `
      <span class="sponsor-badge-wrap" aria-label="Спонсор">
        <svg class="sponsor-badge-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path class="sponsor-badge-gem" d="M6 3L2 9L12 21L22 9L18 3H6Z"/>
          <path d="M2 9H22M12 21L9 9L6 3M12 21L15 9L18 3M9 9H15" stroke="rgba(255,255,255,0.5)" stroke-width="0.8" fill="none"/>
        </svg>
        <span class="sponsor-tooltip">💎 Спонсор</span>
      </span>
    `;
  }

  function getUserBadge(profile) {
    if (profile.id === DEV_UID) return devBadgeHTML();
    if (SPONSOR_UIDS.has(profile.id)) return sponsorBadgeHTML();
    if (isBot(profile)) return botBadgeHTML();
    return '';
  }

  function isBot() { return false; }

  // ---- Вспомогательные функции ----
  const getEl = (id) => document.getElementById(id);

  function formatTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    const oneDay = 86400000;

    if (diff < 60000) return 'только что';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' мин';
    if (diff < oneDay) return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (diff < 7 * oneDay) {
      return date.toLocaleDateString('ru-RU', { weekday: 'short' });
    }
    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
  }

  function getFileIcon(fileType) {
    if (!fileType) return '📎';
    if (fileType.startsWith('image/')) return '🖼️';
    if (fileType.startsWith('video/')) return '🎬';
    if (fileType.startsWith('audio/')) return '🎵';
    if (fileType.includes('pdf')) return '📄';
    if (fileType.includes('word') || fileType.includes('document')) return '📝';
    if (fileType.includes('excel') || fileType.includes('sheet')) return '📊';
    if (fileType.includes('zip') || fileType.includes('rar') || fileType.includes('archive')) return '🗜️';
    return '📎';
  }

  // Возвращает отображаемое имя: display_name если задан, иначе username
  function getDisplayName(profile) {
    if (!profile) return '?';
    return (profile.display_name && profile.display_name.trim()) ? profile.display_name.trim() : profile.username;
  }

  function getAvatarHTML(profile, size = 40) {
    if (profile && profile.avatar_url) {
      return `<img src="${profile.avatar_url}" alt="${profile.username}" class="avatar-img" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;cursor:pointer;" onclick="Chat.openImageModal('${profile.avatar_url}')">`;
    }
    const displayStr = profile ? getDisplayName(profile) : '?';
    const initials = displayStr.charAt(0).toUpperCase();
    const colors = ['#6C63FF', '#FF6584', '#43B89C', '#F9A825', '#EF5350', '#42A5F5', '#AB47BC', '#26A69A'];
    const colorIndex = profile ? profile.username.charCodeAt(0) % colors.length : 0;
    const bg = colors[colorIndex];
    return `<div class="avatar-placeholder" style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;font-size:${size * 0.4}px;color:white;font-weight:700;flex-shrink:0;">${initials}</div>`;
  }

  // ---- Stranger / Block helpers ----

  // Проверяет, писал ли userId нам раньше (они известный контакт)
  async function isKnownContact(userId) {
    // Явно удалённый контакт — показываем баннер незнакомца независимо от истории
    if (removedContacts.has(userId)) return false;
    // В контактах — знакомый
    if (trustedUsers.has(userId)) return true;
    if (!currentUser) return true;
    try {
      const { data } = await window.supabaseClient
        .from('messages')
        .select('id')
        .eq('sender_id', userId)
        .eq('receiver_id', currentUser.id)
        .limit(1)
        .maybeSingle();
      return !!data;
    } catch { return true; }
  }

  async function updateStrangerBanner(userId) {
    const banner = getEl('stranger-banner');
    if (!banner) return;

    // Свои сообщения — без плашки
    if (!userId || userId === currentUser?.id) {
      banner.style.display = 'none';
      return;
    }

    // Заблокированный — без плашки (чат не должен быть открыт, но на всякий случай)
    if (blockedUsers.has(userId)) {
      banner.style.display = 'none';
      return;
    }

    // Уже в контактах — без плашки
    if (trustedUsers.has(userId)) {
      banner.style.display = 'none';
      return;
    }

    // Проверяем историю: нам когда-либо писал этот человек?
    const known = await isKnownContact(userId);
    if (known) {
      banner.style.display = 'none';
      return;
    }

    // Незнакомец — показываем плашку, перепривязываем кнопки
    banner.style.display = '';
    const addBtn = banner.querySelector('.stranger-add-btn');
    const blockBtn = banner.querySelector('.stranger-block-btn');
    if (addBtn) addBtn.onclick = () => addToContacts(userId);
    if (blockBtn) blockBtn.onclick = () => blockUser(userId);
  }

  async function addToContacts(userId) {
    const banner = getEl('stranger-banner');
    if (banner) banner.style.display = 'none';
    // Вызываем полный addContact — записывает в БД и localStorage
    await addContact(userId);
  }

  async function blockUser(userId) {
    if (!currentUser) return;
    blockedUsers.add(userId);
    trustedUsers.delete(userId); // убираем из контактов если был
    saveBlockedUsers();

    // Записываем блокировку в Supabase (таблица user_blocks) чтобы другой пользователь знал
    try {
      await window.supabaseClient
        .from('user_blocks')
        .upsert({ blocker_id: currentUser.id, blocked_id: userId }, { onConflict: 'blocker_id,blocked_id' });
    } catch (err) {
      // Таблица может не существовать — fallback на localStorage
      console.warn('user_blocks table not found, using localStorage fallback:', err.message);
      try {
        const key = `iflash_blockedby_${userId}`;
        const raw = localStorage.getItem(key);
        const arr = raw ? JSON.parse(raw) : [];
        if (!arr.includes(currentUser.id)) arr.push(currentUser.id);
        localStorage.setItem(key, JSON.stringify(arr));
      } catch {}
    }

    // Скрываем плашку
    const banner = getEl('stranger-banner');
    if (banner) banner.style.display = 'none';

    // Закрываем чат немедленно
    selectedChat = null;
    const chatArea = getEl('chat-area');
    const welcomeScreen = getEl('welcome-screen');
    if (chatArea) chatArea.style.display = 'none';
    if (welcomeScreen) welcomeScreen.style.display = '';

    // Очищаем контейнер сообщений
    const msgContainer = getEl('messages-container');
    if (msgContainer) msgContainer.innerHTML = '';

    // Удаляем сообщения: два отдельных запроса (RLS может не поддерживать .or с двумя парами)
    try {
      await window.supabaseClient
        .from('messages')
        .delete()
        .eq('sender_id', currentUser.id)
        .eq('receiver_id', userId);
    } catch (err) {
      console.error('Ошибка удаления исходящих:', err);
    }
    try {
      await window.supabaseClient
        .from('messages')
        .delete()
        .eq('sender_id', userId)
        .eq('receiver_id', currentUser.id);
    } catch (err) {
      console.error('Ошибка удаления входящих:', err);
    }

    // Обновляем список диалогов (заблокированного там не должно быть)
    loadConversations();

    showToast('Пользователь заблокирован', 'error');
  }

  async function unblockUser() {
    if (!selectedChat) return;
    const userId = selectedChat.id;

    blockedUsers.delete(userId);
    saveBlockedUsers();

    // Удаляем запись из Supabase
    try {
      await window.supabaseClient
        .from('user_blocks')
        .delete()
        .eq('blocker_id', currentUser.id)
        .eq('blocked_id', userId);
    } catch {
      // Таблица не существует — только localStorage
    }

    // Обновляем UI: скрываем blocked-screen, показываем чат нормально
    const blockedScreen = getEl('blocked-screen');
    const msgContainer = getEl('messages-container');
    const inputArea = document.querySelector('.chat-input-area');
    if (blockedScreen) blockedScreen.style.display = 'none';
    if (msgContainer) msgContainer.style.display = '';
    if (inputArea) inputArea.style.display = '';

    // Перезагружаем чат
    await loadMessages(userId);
    loadConversations();

    // Обновляем кнопку блокировки в шапке чата (исправляет баг с кнопкой)
    if (selectedChat) renderChatHeader(selectedChat);

    showToast('Пользователь разблокирован', 'success');
  }

  // Показать модал «Сообщение не отправлено» (для заблокированных)
  function showBlockedModal() {
    // Создаём модал динамически
    const existing = getEl('blocked-modal');
    if (existing) { existing.style.display = 'flex'; return; }

    const modal = document.createElement('div');
    modal.id = 'blocked-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);
    `;
    modal.innerHTML = `
      <div style="background:var(--bg-tertiary);border:1px solid var(--glass-border);border-radius:20px;padding:32px 28px;max-width:320px;width:90%;text-align:center;box-shadow:var(--shadow-lg);">
        <div style="font-size:40px;margin-bottom:16px;">🔒</div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary);margin-bottom:8px;">Сообщение не отправлено</div>
        <div style="font-size:14px;color:var(--text-secondary);line-height:1.5;margin-bottom:20px;">Вы ограничены в общении с этим пользователем</div>
        <button onclick="document.getElementById('blocked-modal').style.display='none'"
          style="background:var(--accent-color);color:white;border:none;border-radius:12px;padding:10px 28px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">
          Понятно
        </button>
      </div>
    `;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
    });
    document.body.appendChild(modal);
  }

  // Модал: настройки приватности блокируют действие
  function showPrivacyBlockModal(message) {
    const existing = getEl('privacy-block-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'privacy-block-modal';
    modal.style.cssText = `
      position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);
    `;
    modal.innerHTML = `
      <div style="background:var(--bg-tertiary);border:1px solid var(--glass-border);border-radius:20px;padding:32px 28px;max-width:340px;width:90%;text-align:center;box-shadow:var(--shadow-lg);">
        <div style="font-size:40px;margin-bottom:16px;">🛡️</div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary);margin-bottom:8px;">Действие недоступно</div>
        <div style="font-size:14px;color:var(--text-secondary);line-height:1.5;margin-bottom:20px;">${message}</div>
        <button onclick="document.getElementById('privacy-block-modal').remove()"
          style="background:var(--accent-color);color:white;border:none;border-radius:12px;padding:10px 28px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">
          Понятно
        </button>
      </div>
    `;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
    document.body.appendChild(modal);
  }

  // ---- Загрузка профиля текущего пользователя ----
  async function loadCurrentProfile(userId) {
    try {
      const { data, error } = await window.supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (error) {
        console.error('Ошибка загрузки профиля:', error);
        return null;
      }

      currentProfile = data;
      renderSettingsProfile();
      return data;
    } catch (err) {
      console.error('Ошибка:', err);
      return null;
    }
  }

  // ---- Загрузка всех профилей ----
  async function loadAllProfiles() {
    try {
      const { data, error } = await window.supabaseClient
        .from('profiles')
        .select('*')
        .neq('id', currentUser.id)
        .order('username');

      if (error) {
        console.error('Ошибка загрузки профилей:', error);
        return;
      }

      allProfiles = data || [];
      // Rebuild fast-lookup map
      _profilesMap.clear();
      allProfiles.forEach(p => _profilesMap.set(p.id, p));
    } catch (err) {
      console.error('Ошибка:', err);
    }
  }

  // ---- Загрузка диалогов: максимум 1 раз в 3с ----
  // Независимо от количества вызовов — выполняется не чаще чем раз в 3 секунды.
  // Если вызов пришёл во время выполнения или в период кулдауна — ставится В ОЧЕРЕДЬ
  // (один, не много), и выполняется после кулдауна.
  let _loadConvRunning  = false;
  let _loadConvPending  = false;
  let _loadConvTimer    = null;
  let _loadConvLastRun  = 0;
  const _LOAD_CONV_COOLDOWN = 3000; // мс

  function loadConversations() {
    _scheduleLoadConv();
    return Promise.resolve();
  }

  function _scheduleLoadConv() {
    const now  = Date.now();
    const wait = _LOAD_CONV_COOLDOWN - (now - _loadConvLastRun);

    if (_loadConvRunning) {
      // Уже идёт запрос — запомним что нужен ещё один
      _loadConvPending = true;
      return;
    }

    if (wait > 0) {
      // Кулдаун ещё не истёк — планируем один запуск через оставшееся время
      _loadConvPending = true;
      if (!_loadConvTimer) {
        _loadConvTimer = setTimeout(_runLoadConv, wait);
      }
      return;
    }

    // Кулдаун истёк — запускаем немедленно
    _runLoadConv();
  }

  async function _runLoadConv() {
    if (_loadConvRunning) return;
    _loadConvTimer   = null;
    _loadConvPending = false;
    _loadConvRunning = true;
    _loadConvLastRun = Date.now();
    try { await _loadConversationsImpl(); } catch(e) { console.error(e); }
    _loadConvRunning = false;

    // Если за время выполнения пришли новые запросы — выполним один раз после кулдауна
    if (_loadConvPending && !_loadConvTimer) {
      _loadConvPending = false;
      _loadConvTimer = setTimeout(_runLoadConv, _LOAD_CONV_COOLDOWN);
    }
  }

  async function _loadConversationsImpl() {
    try {
      const { data: sentMessages, error: sentError } = await window.supabaseClient
        .from('messages')
        .select(`
          id,
          sender_id,
          receiver_id,
          content,
          file_name,
          created_at,
          is_read
        `)
        .eq('sender_id', currentUser.id)
        .order('created_at', { ascending: false });

      const { data: receivedMessages, error: receivedError } = await window.supabaseClient
        .from('messages')
        .select(`
          id,
          sender_id,
          receiver_id,
          content,
          file_name,
          created_at,
          is_read
        `)
        .eq('receiver_id', currentUser.id)
        .order('created_at', { ascending: false });

      if (sentError || receivedError) {
        console.error('Ошибка загрузки диалогов:', sentError || receivedError);
        return;
      }

      // Объединяем и находим уникальных собеседников
      const allMsgs = [...(sentMessages || []), ...(receivedMessages || [])];
      const partnerMap = {};

      for (const msg of allMsgs) {
        const partnerId = msg.sender_id === currentUser.id ? msg.receiver_id : msg.sender_id;
        if (!partnerMap[partnerId] || new Date(msg.created_at) > new Date(partnerMap[partnerId].created_at)) {
          partnerMap[partnerId] = msg;
        }
      }

      // Загружаем профили собеседников
      const partnerIds = Object.keys(partnerMap);
      if (partnerIds.length === 0) {
        conversationsList = [];
        await loadGroups();
        renderConversations();
        return;
      }

      const { data: partnerProfiles, error: profileError } = await window.supabaseClient
        .from('profiles')
        .select('*')
        .in('id', partnerIds);

      if (profileError) {
        console.error('Ошибка загрузки профилей собеседников:', profileError);
        return;
      }

      // Подсчёт непрочитанных
      const unreadCounts = {};
      for (const msg of (receivedMessages || [])) {
        if (!msg.is_read) {
          unreadCounts[msg.sender_id] = (unreadCounts[msg.sender_id] || 0) + 1;
        }
      }

      conversationsList = (partnerProfiles || [])
        .filter(profile => !blockedUsers.has(profile.id))
        .map((profile) => ({
          profile,
          lastMessage: partnerMap[profile.id],
          unreadCount: unreadCounts[profile.id] || 0
        })).sort((a, b) => new Date(b.lastMessage.created_at) - new Date(a.lastMessage.created_at));

      // Расшифровываем превью последних сообщений для сайдбара
      if (window.Encryption) {
        const encConvs = conversationsList.filter(c =>
          c.lastMessage.content && window.Encryption.isEncrypted(c.lastMessage.content)
        );
        if (encConvs.length > 0) {
          const allIds = [...new Set(encConvs.flatMap(c =>
            [c.lastMessage.sender_id, c.lastMessage.receiver_id].filter(Boolean)
          ))];
          await window.Encryption.preloadKeys(allIds);
          await Promise.all(encConvs.map(async c => {
            try {
              const d = await decryptMsg(c.lastMessage);
              c.lastMessage = { ...c.lastMessage, content: d.content };
            } catch {}
          }));
        }
      }

      // Параллельно обновляем группы
      await loadGroups();
      _loadGroupUnreadCounts().then(() => {
        const convList = getEl('conversations-list');
        if (convList) renderGroupsInList(convList);
      });
      renderConversations();
    } catch (err) {
      console.error('Ошибка загрузки диалогов:', err);
    }
  }

  // ---- Рендер списка диалогов ----
  function renderConversations(filterText = '') {
    const list = getEl('conversations-list');
    if (!list) return;

    // ---- Режим поиска: пользователи + сообщения в диалогах + группы ----
    if (isSearchMode) {
      const hasUsers      = searchModeResults.length > 0;
      const hasMsgs       = searchMsgResults.length > 0;
      const hasGroupMsg   = searchGroupMsgResults.length > 0;
      const chResults     = (window.Channels ? window.Channels.getSearchChannelResults() : []) || [];
      const hasChannels   = chResults.length > 0;

      if (!hasUsers && !hasMsgs && !hasGroupMsg && !hasChannels) {
        list.innerHTML = `
          <div class="empty-conversations search-empty">
            <div class="empty-icon">🔍</div>
            <p>Ничего не найдено</p>
          </div>
        `;
        return;
      }

      let html = '';

      // --- Секция: пользователи ---
      if (hasUsers) {
        html += `<div class="search-results-header">Пользователи</div>`;
        html += searchModeResults.map(profile => {
          const badge    = getUserBadge(profile);
          const isActive = selectedChat && selectedChat.id === profile.id;
          return `
            <div class="conversation-item search-result-item-inline ${isActive ? 'active' : ''}"
                 data-user-id="${profile.id}"
                 onclick="Chat.openChatWithUser('${profile.id}')">
              <div class="conv-avatar">${getAvatarHTML(profile, 46)}</div>
              <div class="conv-info">
                <div class="conv-header">
                  <span class="conv-name" style="display:flex;align-items:center;gap:4px;">${escapeHTML(getContactDisplayName(profile))}${badge}</span>
                </div>
                <div class="conv-preview">
                  <span class="conv-text search-result-username">@${escapeHTML(profile.username)}</span>
                </div>
              </div>
            </div>`;
        }).join('');
      }

      // --- Секция: сообщения в личных диалогах ---
      if (hasMsgs) {
        html += `<div class="search-results-header">Сообщения</div>`;
        html += searchMsgResults.map(({ profile, message }) => {
          const isActive  = selectedChat && selectedChat.id === profile.id;
          const badge     = getUserBadge(profile);
          const snippet   = buildSearchSnippet(message.content, searchCurrentQuery);
          const isMine    = message.sender_id === currentUser.id;
          const timeStr   = formatTime(message.created_at);
          return `
            <div class="conversation-item search-result-item-inline search-result-msg ${isActive ? 'active' : ''}"
                 data-user-id="${profile.id}"
                 onclick="Chat.openChatWithUser('${profile.id}')">
              <div class="conv-avatar">${getAvatarHTML(profile, 46)}</div>
              <div class="conv-info">
                <div class="conv-header">
                  <span class="conv-name" style="display:flex;align-items:center;gap:4px;">${escapeHTML(getContactDisplayName(profile))}${badge}</span>
                  <span class="conv-time search-result-time">${timeStr}</span>
                </div>
                <div class="conv-preview">
                  <span class="conv-text">${isMine ? '<span class="search-result-mine">Вы: </span>' : ''}${snippet}</span>
                </div>
              </div>
            </div>`;
        }).join('');
      }

      // --- Секция: сообщения в группах ---
      if (hasGroupMsg) {
        html += `<div class="search-results-header">Группы</div>`;
        html += searchGroupMsgResults.map(({ group, message }) => {
          const isActive  = selectedGroup && selectedGroup.id === group.id;
          const snippet   = buildSearchSnippet(message.content, searchCurrentQuery);
          const isMine    = message.sender_id === currentUser.id;
          const timeStr   = formatTime(message.created_at);
          const senderProfile = isMine ? null : allProfiles.find(p => p.id === message.sender_id);
          const senderPrefix  = isMine
            ? '<span class="search-result-mine">Вы: </span>'
            : (senderProfile ? `<span class="search-result-mine">${escapeHTML(getContactDisplayName(senderProfile))}: </span>` : '');
          const groupAvatarHTML = group.avatar_url
            ? `<img src="${group.avatar_url}" style="width:46px;height:46px;border-radius:13px;object-fit:cover;flex-shrink:0;" alt="group">`
            : `<div class="conv-group-avatar" style="width:46px;height:46px;border-radius:13px;flex-shrink:0;">
                 <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="7" r="3"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0-3-3.85"/></svg>
               </div>`;
          return `
            <div class="conversation-item search-result-item-inline search-result-msg ${isActive ? 'active' : ''}"
                 data-group-id="${group.id}"
                 onclick="Chat.openGroupChat(${JSON.stringify(group).replace(/"/g, '&quot;')})">
              <div class="conv-avatar">${groupAvatarHTML}</div>
              <div class="conv-info">
                <div class="conv-header">
                  <span class="conv-name">${escapeHTML(group.name || 'Группа')}</span>
                  <span class="conv-time search-result-time">${timeStr}</span>
                </div>
                <div class="conv-preview">
                  <span class="conv-text">${senderPrefix}${snippet}</span>
                </div>
              </div>
            </div>`;
        }).join('');
      }

      // --- Секция: публичные каналы ---
      if (hasChannels) {
        html += `<div class="search-results-header">Каналы</div>`;
        html += chResults.map(ch => {
          const avatarHTML = ch.avatar_url
            ? `<div class="search-channel-result-avatar"><img src="${escapeHTML(ch.avatar_url)}" alt=""></div>`
            : `<div class="search-channel-result-avatar">📢</div>`;
          const typeLabel = ch.is_public ? 'Публичный' : '🔒 Приватный';
          const membersStr = ch.member_count !== null && ch.member_count !== undefined
            ? (ch.member_count + ' подписч.') : '';
          const joined = ch.i_am_member;
          return `
            <div class="conversation-item search-result-item-inline conv-channel-item ${joined ? 'active' : ''}"
                 onclick="if(window.Channels)Channels.openChannelChat(${JSON.stringify(ch).replace(/"/g, '&quot;')})">
              ${avatarHTML}
              <div class="conv-info">
                <div class="conv-header">
                  <span class="conv-name">${escapeHTML(ch.name)}</span>
                  <span class="conv-channel-tag">Канал</span>
                </div>
                <div class="conv-preview">
                  <span class="conv-text">${escapeHTML(typeLabel)}${membersStr ? ' · ' + membersStr : ''}${joined ? ' · <b>Вы подписаны</b>' : ''}</span>
                </div>
              </div>
            </div>`;
        }).join('');
      }

      list.innerHTML = html;
      return;
    }

    const filtered = filterText
      ? conversationsList.filter(({ profile }) =>
          profile.username.toLowerCase().includes(filterText.toLowerCase()))
      : conversationsList;

    if (filtered.length === 0) {
      // Показываем "нет диалогов" только если нет ни личных чатов, ни групп
      if (groups.length === 0) {
        list.innerHTML = `
          <div class="empty-conversations">
            <div class="empty-icon">💬</div>
            <p>${filterText ? 'Диалоги не найдены' : 'Нет диалогов. Найдите пользователей через поиск!'}</p>
          </div>
        `;
      } else {
        list.innerHTML = '';
      }
      renderGroupsInList(list);
      return;
    }

    list.innerHTML = filtered.map(({ profile, lastMessage, unreadCount }) => {
      const isActive = selectedChat && selectedChat.id === profile.id;
      let lastText = '';
      if (lastMessage.file_name) {
        if (lastMessage.file_name.startsWith('vidnote_')) {
          lastText = '🎥 Кружок';
        } else if (lastMessage.file_name.startsWith('voice_')) {
          lastText = '🎤 Голосовое сообщение';
        } else if (lastMessage.file_type && (lastMessage.file_type.startsWith('audio/') || lastMessage.file_type.includes('webm') || lastMessage.file_type.includes('ogg'))) {
          lastText = '🎤 Голосовое сообщение';
        } else {
          lastText = `📎 ${lastMessage.file_name}`;
        }
      } else {
        lastText = lastMessage.content || '';
      }
      // Пересланное сообщение — показываем человекочитаемое превью
      if (lastText.startsWith('↪️__FWD__') || /^↪️ Переслано от /.test(lastText)) {
        lastText = '↪️ Пересланное сообщение';
      } else if (/^↪ Переслано из канала «/.test(lastText)) {
        lastText = '↪ Переслано из канала';
      }
      // E2EE: зашифрованное сообщение — показываем заглушку
      if (window.Encryption && window.Encryption.isEncrypted(lastText)) {
        lastText = '🔒 Сообщение';
      }
      // Превью: обрезаем до 35 символов (по сырому тексту), потом форматируем
      const rawPreview = lastText.length > 35 ? lastText.slice(0, 35) + '…' : lastText;
      const formattedPreview = formatMessageText(rawPreview.replace(/\n+/g, ' '));
      const isOwn = lastMessage.sender_id === currentUser.id;

      const nameBadge = getUserBadge(profile);
      // Черновик — показываем вместо превью последнего сообщения
      const draftKey = `user_${profile.id}`;
      const draftText = draftsMap[draftKey];
      let previewHTML;
      if (draftText && draftText.trim()) {
        const dp = draftText.length > 32 ? draftText.slice(0, 32) + '…' : draftText;
        previewHTML = `<span class="draft-label">Черновик:</span> ${escapeHTML(dp)}`;
      } else if (isOwn) {
        previewHTML = `<span class="you-label">Вы: </span><span class="conv-text-own">${formattedPreview}</span>`;
      } else {
        previewHTML = `<span class="conv-text-other">${formattedPreview}</span>`;
      }
      return `
        <div class="conversation-item ${isActive ? 'active' : ''}" data-user-id="${profile.id}" onclick="Chat.selectConversation('${profile.id}')">
          <div class="conv-avatar">
            <div class="av-status-wrap">
              ${getContactAvatarHTML(profile, 46)}
              ${_onlineDotHTML(profile.id, _isUserOnline(profile))}
            </div>
          </div>
          <div class="conv-info">
            <div class="conv-header">
              <span class="conv-name" style="display:flex;align-items:center;gap:4px;">${escapeHTML(getContactDisplayName(profile))}${nameBadge}</span>
              <span class="conv-time">${formatTime(lastMessage.created_at)}</span>
            </div>
            <div class="conv-preview">
              <span class="conv-text">${previewHTML}</span>
              ${(unreadCount > 0 || manuallyUnreadUsers.has(profile.id)) ? `<span class="unread-badge">${unreadCount > 0 ? unreadCount : '●'}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Добавляем группы в начало списка
    renderGroupsInList(list);
  }

  // ---- Построить сниппет с подсветкой совпадения ----
  function buildSearchSnippet(content, rawQuery) {
    if (!content) return '';
    const lc = content.toLowerCase();
    const qi = lc.indexOf(rawQuery.toLowerCase());
    if (qi === -1) return escapeHTML(content.slice(0, 50));
    const start = Math.max(0, qi - 15);
    const end   = Math.min(content.length, qi + rawQuery.length + 30);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < content.length ? '…' : '';
    return (
      prefix +
      escapeHTML(content.slice(start, qi)) +
      `<mark class="search-highlight">${escapeHTML(content.slice(qi, qi + rawQuery.length))}</mark>` +
      escapeHTML(content.slice(qi + rawQuery.length, end)) +
      suffix
    );
  }

  // ---- Комплексный поиск: пользователи + сообщения в диалогах + группах ----
  async function handleSearch(query) {
    // Старый popup-элемент — скрываем, он теперь не используется
    const searchResultsPopup = getEl('search-results');
    if (searchResultsPopup) {
      searchResultsPopup.classList.remove('visible');
      searchResultsPopup.innerHTML = '';
    }

    if (!query || query.trim().length < 1) {
      isSearchMode = false;
      searchModeResults = [];
      searchMsgResults = [];
      searchGroupMsgResults = [];
      searchCurrentQuery = '';
      renderConversations();
      return;
    }

    const q = query.trim();
    searchCurrentQuery = q;
    isSearchMode = true;

    // Запускаем три поиска параллельно
    const [usersRes, sentRes, recvRes, groupMsgsRes] = await Promise.allSettled([
      // 1. Поиск по имени пользователя
      window.supabaseClient
        .from('profiles')
        .select('*')
        .neq('id', currentUser.id)
        .ilike('username', `%${q}%`)
        .limit(12),

      // 2. Поиск по исходящим сообщениям
      window.supabaseClient
        .from('messages')
        .select('id, content, created_at, sender_id, receiver_id')
        .eq('sender_id', currentUser.id)
        .ilike('content', `%${q}%`)
        .order('created_at', { ascending: false })
        .limit(50),

      // 3. Поиск по входящим сообщениям
      window.supabaseClient
        .from('messages')
        .select('id, content, created_at, sender_id, receiver_id')
        .eq('receiver_id', currentUser.id)
        .ilike('content', `%${q}%`)
        .order('created_at', { ascending: false })
        .limit(50),

      // 4. Поиск по сообщениям в группах
      groups.length > 0
        ? window.supabaseClient
            .from('group_messages')
            .select('id, content, created_at, sender_id, group_id')
            .in('group_id', groups.map(g => g.id))
            .ilike('content', `%${q}%`)
            .order('created_at', { ascending: false })
            .limit(50)
        : Promise.resolve({ value: { data: [] } })
    ]);

    // Если запрос сменился пока ждали — игнорируем устаревший результат
    if (searchCurrentQuery !== q) return;

    // Поиск публичных каналов
    if (window.Channels) await window.Channels.searchPublicChannels(q);

    // --- Пользователи ---
    searchModeResults = (usersRes.status === 'fulfilled' ? usersRes.value.data : null) || [];

    // --- Сообщения в личных чатах ---
    const sentMsgs = (sentRes.status === 'fulfilled' ? sentRes.value.data : null) || [];
    const recvMsgs = (recvRes.status === 'fulfilled' ? recvRes.value.data : null) || [];
    const allDmMsgs = [...sentMsgs, ...recvMsgs].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );
    // Одна запись на диалог — самое свежее совпадение
    const partnerSeen = new Set();
    const dmResults = [];
    for (const msg of allDmMsgs) {
      const partnerId = msg.sender_id === currentUser.id ? msg.receiver_id : msg.sender_id;
      if (partnerSeen.has(partnerId)) continue;
      partnerSeen.add(partnerId);
      const profile =
        allProfiles.find(p => p.id === partnerId) ||
        conversationsList.find(c => c.profile && c.profile.id === partnerId)?.profile;
      if (profile) dmResults.push({ profile, message: msg });
    }
    searchMsgResults = dmResults;

    // --- Сообщения в группах ---
    const gMsgs = (groupMsgsRes.status === 'fulfilled'
      ? (groupMsgsRes.value?.data ?? groupMsgsRes.value?.value?.data)
      : null) || [];
    const groupSeen = new Set();
    const grpResults = [];
    for (const msg of gMsgs) {
      if (groupSeen.has(msg.group_id)) continue;
      groupSeen.add(msg.group_id);
      const group = groups.find(g => g.id === msg.group_id);
      if (group) grpResults.push({ group, message: msg });
    }
    searchGroupMsgResults = grpResults;

    renderConversations();
  }

  // Сбросить поиск и вернуть список диалогов
  function clearSearch() {
    isSearchMode = false;
    searchModeResults = [];
    searchMsgResults = [];
    searchGroupMsgResults = [];
    searchCurrentQuery = '';
    const searchInput = getEl('search-input');
    if (searchInput) searchInput.value = '';
    renderConversations();
  }

  // ---- Выбор диалога из списка ----
  async function selectConversation(userId) {
    const profile = conversationsList.find(({ profile }) => profile.id === userId)?.profile;
    if (!profile) {
      // Загружаем профиль, если не в кэше
      const { data } = await window.supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      if (data) await openChatWithUser(data.id);
      return;
    }
    await openChatWithUser(profile.id);
  }

  // ---- Открытие чата с пользователем ----
  async function openChatWithUser(userId) {
    // ── Инвалидируем предыдущую загрузку сообщений — сразу при переключении ──
    ++_chatLoadGen;

    // Снимаем ручную пометку "непрочитанное" при открытии чата
    manuallyUnreadUsers.delete(userId);
    // Сбрасываем выбранную группу при открытии личного чата
    selectedGroup = null;
    closeGroupInfo();
    // Сбрасываем выбранный канал
    if (window.Channels) {
      window.Channels.clearSelectedChannel();
      const oldFooter = document.getElementById('channel-footer-panel');
      if (oldFooter) oldFooter.remove();
    }
    // Сбрасываем поиск при открытии чата
    if (isSearchMode) {
      isSearchMode = false;
      searchModeResults = [];
      const searchInput = getEl('search-input');
      if (searchInput) searchInput.value = '';
    } else {
      const searchInput = getEl('search-input');
      if (searchInput) searchInput.value = '';
    }
    // Popup-результаты (legacy, на всякий случай)
    const searchResults = getEl('search-results');
    if (searchResults) {
      searchResults.classList.remove('visible');
      searchResults.innerHTML = '';
    }

    // Загружаем профиль, если нужно
    let profile = allProfiles.find((p) => p.id === userId);
    if (!profile) {
      const { data } = await window.supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      profile = data;
      if (profile) _cacheProfile(profile);
    }

    if (!profile) return;

    selectedChat = profile;

    // Обновляем активный диалог в списке
    document.querySelectorAll('.conversation-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.userId === userId);
    });

    // Рендерим шапку чата
    renderChatHeader(profile);
    // Показываем кнопку «Цифровая вежливость» только в DM
    _updateSendOnlineBtn();

    // Показываем область чата
    const welcomeScreen = getEl('welcome-screen');
    const chatArea = getEl('chat-area');
    if (welcomeScreen) welcomeScreen.style.display = 'none';
    if (chatArea) chatArea.style.display = 'flex';

    // Проверяем: заблокирован ли этот пользователь нами
    const isBlocked = blockedUsers.has(userId);
    const blockedScreen = getEl('blocked-screen');
    const msgContainer = getEl('messages-container');
    const inputArea = document.querySelector('.chat-input-area');
    const strangerBanner = getEl('stranger-banner');

    if (isBlocked) {
      // Показываем экран блокировки, скрываем всё остальное
      if (blockedScreen) blockedScreen.style.display = 'flex';
      if (msgContainer) msgContainer.style.display = 'none';
      if (inputArea) inputArea.style.display = 'none';
      if (strangerBanner) strangerBanner.style.display = 'none';
      return; // не грузим сообщения
    }

    // Не заблокирован — нормальный режим
    if (blockedScreen) blockedScreen.style.display = 'none';
    if (msgContainer) {
      msgContainer.style.display = '';
      msgContainer.classList.remove('chat-enter');
      void msgContainer.offsetWidth;
      msgContainer.classList.add('chat-enter');
      msgContainer.addEventListener('animationend', () => msgContainer.classList.remove('chat-enter'), { once: true });
    }

    // Показываем ввод для всех чатов (включая бота)
    if (inputArea) {
      inputArea.style.display = '';
    }

    // Убираем кнопку /start бота (если была)
    const oldBotStart = document.getElementById('bot-start-panel');
    if (oldBotStart) oldBotStart.remove();

    // Обновляем плашку незнакомца
    await updateStrangerBanner(userId);

    // Помечаем сообщения как прочитанные
    await markMessagesAsRead(userId);

    // Сбрасываем поиск при смене чата
    if (msgSearchActive) {
      msgSearchActive = false;
      const bar = getEl('msg-search-bar');
      const input = getEl('msg-search-input');
      if (bar) bar.style.display = 'none';
      if (input) input.value = '';
      msgSearchQuery = '';
    }

    // Загружаем сообщения
    await loadMessages(userId);

    // Обновляем список диалогов (debounce — не блокируем UI)
    loadConversations();

    // Восстанавливаем черновик для открытого чата
    restoreDraftForCurrentChat();

    // На мобильных — показываем правую панель
    const sidebar = document.querySelector('.sidebar');
    const mainChat = document.querySelector('.main-chat');
    if (window.innerWidth <= 768) {
      if (sidebar) sidebar.classList.add('hidden-mobile');
      if (mainChat) mainChat.classList.add('visible-mobile');
    }
  }

  // ---- Рендер шапки чата ----
  function renderChatHeader(profile) {
    const header = getEl('chat-header-content');
    if (!header) return;

    const isBlocked = blockedUsers.has(profile.id);
    const blockBtn = profile.id === currentUser?.id ? '' : `
      <button
        class="icon-btn header-block-btn ${isBlocked ? 'header-block-btn--blocked' : ''}"
        onclick="Chat.toggleBlockFromHeader('${profile.id}')"
        title="${isBlocked ? 'Разблокировать' : 'Заблокировать'}"
      >
        ${isBlocked
          ? `<svg width="17" height="17" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="currentColor"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>`
          : `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9"/><line x1="5.64" y1="5.64" x2="18.36" y2="18.36"/></svg>`
        }
      </button>
    `;

    header.innerHTML = `
      <button class="back-btn" onclick="Chat.goBackToList()" title="Назад">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      </button>
      <div class="chat-header-user" onclick="Chat.showUserProfile('${profile.id}')" style="cursor:pointer;">
        ${getContactAvatarHTML(profile, 40)}
        <div class="chat-header-info">
          <span class="chat-header-name">${escapeHTML(getContactDisplayName(profile))}${getUserBadge(profile)}</span>
          <span class="chat-header-status status-loading" id="chat-status-${profile.id}">@${escapeHTML(profile.username)}</span>
        </div>
      </div>
      <div class="chat-header-actions">
        <button class="icon-btn header-call-btn" onclick="Chat.initiateCall('${profile.id}')" title="Голосовой звонок">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.87a16 16 0 0 0 6.13 6.13l1.27-.99a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </button>
        <button class="icon-btn header-search-btn" onclick="Chat.toggleMsgSearch()" title="Поиск по сообщениям">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
        ${blockBtn}
      </div>
    `;
    // Подгружаем и показываем last seen
    loadLastSeen(profile).then(statusText => {
      const el = document.getElementById(`chat-status-${profile.id}`);
      if (el) {
        el.textContent = statusText;
        el.className = 'chat-header-status ' + (statusText === 'в сети' ? 'status-online' : 'status-offline');
      }
    });
    // Подписываемся на изменения профиля (realtime last seen)
    subscribeToPresence(profile.id);
    // Подписываемся на typing
    subscribeToTyping(profile.id);
    // Показать закреплённое сообщение для этого чата
    loadAndShowPinBar();
  }

  // Диалог подтверждения блокировки
  function showBlockConfirmation(userId) {
    document.getElementById('block-confirm-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'block-confirm-modal';
    modal.style.cssText = [
      'position:fixed;inset:0;z-index:10001',
      'display:flex;align-items:center;justify-content:center',
      'background:rgba(0,0,0,0.55);backdrop-filter:blur(5px)',
    ].join(';');
    modal.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--glass-border);
                  border-radius:18px;padding:30px 24px;max-width:340px;width:90%;
                  text-align:center;display:flex;flex-direction:column;gap:12px;
                  box-shadow:0 24px 64px rgba(0,0,0,0.5);animation:slideUp .2s ease;">
        <div style="font-size:38px;">🔒</div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary);">Заблокировать пользователя?</div>
        <div style="font-size:13px;color:var(--text-muted);line-height:1.6;">
          Вы уверены, что хотите заблокировать этого пользователя?<br>
          Он не сможет вам писать, а история переписки будет удалена.
        </div>
        <div style="display:flex;gap:10px;margin-top:6px;">
          <button id="block-confirm-cancel"
            style="flex:1;padding:10px;background:var(--bg-glass);
                   border:1px solid var(--border-color);border-radius:10px;
                   font-size:13px;font-weight:600;cursor:pointer;
                   font-family:inherit;color:var(--text-primary);transition:background .15s;">
            Отмена
          </button>
          <button id="block-confirm-ok"
            style="flex:1;padding:10px;background:#ef5350;border:none;
                   border-radius:10px;font-size:13px;font-weight:700;
                   cursor:pointer;font-family:inherit;color:#fff;transition:opacity .15s;">
            Заблокировать
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#block-confirm-cancel').onclick = () => modal.remove();
    modal.querySelector('#block-confirm-ok').onclick = async () => {
      modal.remove();
      await blockUser(userId);
    };
  }

  // Переключатель блокировки из шапки чата
  async function toggleBlockFromHeader(userId) {
    if (blockedUsers.has(userId)) {
      // Разблокировать — unblockUser теперь сам обновляет шапку
      await unblockUser();
    } else {
      // Заблокировать — сначала показываем подтверждение
      showBlockConfirmation(userId);
    }
  }

  // ---- Пометить сообщения как прочитанные ----
  async function markMessagesAsRead(senderId) {
    try {
      await window.supabaseClient
        .from('messages')
        .update({ is_read: true })
        .eq('sender_id', senderId)
        .eq('receiver_id', currentUser.id)
        .eq('is_read', false);
    } catch (err) {
      console.error('Ошибка пометки прочитанных:', err);
    }
  }

  // ---- Загрузка сообщений ----
  async function loadMessages(partnerId) {
    // ── Защита от race condition: каждый вызов получает уникальный номер поколения ──
    const gen = ++_chatLoadGen;

    const messagesContainer = getEl('messages-container');
    if (!messagesContainer) return;

    // Сбрасываем состояние пагинации при смене чата
    paginationPartnerId = partnerId;
    oldestMsgDate = null;
    isLoadingMore = false;
    hasMoreMessages = true;
    disconnectTopObserver();

    messagesContainer.innerHTML = `
      <div class="messages-loading">
        <div class="loading-spinner"></div>
        <span>Загрузка сообщений...</span>
      </div>
    `;

    try {
      const { data, error } = await window.supabaseClient
        .from('messages')
        .select('*')
        .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${currentUser.id})`)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);

      // Пока шёл запрос, пользователь переключился на другой чат — отбрасываем результат
      if (gen !== _chatLoadGen) return;

      if (error) {
        if (gen !== _chatLoadGen) return;
        messagesContainer.innerHTML = `<div class="messages-error">Ошибка загрузки сообщений</div>`;
        console.error('Ошибка загрузки сообщений:', error);
        return;
      }

      const messages = (data || []).reverse(); // хронологически
      if (messages.length > 0) {
        oldestMsgDate = messages[0].created_at;
      }
      // Если вернулось меньше PAGE_SIZE — больше нет
      hasMoreMessages = (data || []).length >= PAGE_SIZE;

      // Ещё раз проверяем перед рендером
      if (gen !== _chatLoadGen) return;
      await renderMessages(messages, gen);

      // Навешиваем IntersectionObserver если есть что грузить ещё
      if (gen === _chatLoadGen && hasMoreMessages) {
        setupTopObserver(partnerId);
      }
    } catch (err) {
      if (gen !== _chatLoadGen) return;
      console.error('Ошибка:', err);
      messagesContainer.innerHTML = `<div class="messages-error">Ошибка сети</div>`;
    }
  }

  // Отключаем и удаляем sentinel
  function disconnectTopObserver() {
    if (topObserver) { topObserver.disconnect(); topObserver = null; }
    const sentinel = getEl('scroll-sentinel');
    if (sentinel) sentinel.remove();
  }

  // Создаём sentinel-элемент вверху контейнера и подключаем IntersectionObserver
  function setupTopObserver(partnerId) {
    const container = getEl('messages-container');
    if (!container) return;

    // Удаляем старый sentinel
    const oldSentinel = getEl('scroll-sentinel');
    if (oldSentinel) oldSentinel.remove();

    const sentinel = document.createElement('div');
    sentinel.id = 'scroll-sentinel';
    sentinel.style.cssText = 'height:1px;width:100%;';
    container.insertBefore(sentinel, container.firstChild);

    topObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isLoadingMore && hasMoreMessages) {
          loadMoreMessages(partnerId);
        }
      },
      { root: container, threshold: 0 }
    );
    topObserver.observe(sentinel);
  }

  // Подгружаем следующую порцию (более старые сообщения)
  async function loadMoreMessages(partnerId) {
    if (isLoadingMore || !hasMoreMessages || !oldestMsgDate) return;
    if (paginationPartnerId !== partnerId) return; // сменился чат
    isLoadingMore = true;

    const container = getEl('messages-container');
    // Показываем спиннер вверху
    const spinner = document.createElement('div');
    spinner.id = 'load-more-spinner';
    spinner.className = 'load-more-spinner';
    spinner.innerHTML = '<div class="loading-spinner-sm"></div>';
    container.insertBefore(spinner, container.firstChild);

    // Запоминаем высоту для сохранения позиции скролла
    const prevScrollHeight = container.scrollHeight;

    try {
      const { data, error } = await window.supabaseClient
        .from('messages')
        .select('*')
        .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${currentUser.id})`)
        .lt('created_at', oldestMsgDate)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);

      spinner.remove();

      if (error) { isLoadingMore = false; return; }

      const messages = (data || []).reverse();
      hasMoreMessages = (data || []).length >= PAGE_SIZE;

      if (messages.length > 0) {
        oldestMsgDate = messages[0].created_at;
        prependMessages(messages);
        // Восстанавливаем позицию скролла
        container.scrollTop = container.scrollHeight - prevScrollHeight;
      }

      if (!hasMoreMessages) {
        disconnectTopObserver();
      }
    } catch (e) {
      const sp = getEl('load-more-spinner');
      if (sp) sp.remove();
    }

    isLoadingMore = false;
  }

  // Вставляем старые сообщения перед существующими
  async function prependMessages(messages) {
    const container = getEl('messages-container');
    if (!container) return;

    const sentinel = getEl('scroll-sentinel');
    let prevDate = null;

    // Определяем первую существующую дату-разделитель
    const firstDivider = container.querySelector('.date-divider');
    if (firstDivider) {
      prevDate = firstDivider.querySelector('span')?.textContent || null;
    }

    // ── E2EE: предзагрузить ключи + расшифровать ─────────────────
    if (window.Encryption) {
      const ids = [...new Set(messages.flatMap(m => [m.sender_id, m.receiver_id]).filter(Boolean))];
      await window.Encryption.preloadKeys(ids);
    }
    const decrypted = window.Encryption
      ? await Promise.all(messages.map(decryptMsg))
      : messages;

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < decrypted.length; i++) {
      const msg = decrypted[i];
      if (renderedMessageIds.has(msg.id)) continue;
      renderedMessageIds.add(msg.id);

      const msgDate = new Date(msg.created_at).toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'long', year: 'numeric'
      });
      if (msgDate !== prevDate) {
        const divider = document.createElement('div');
        divider.className = 'date-divider';
        divider.innerHTML = `<span>${msgDate}</span>`;
        fragment.appendChild(divider);
        prevDate = msgDate;
      }

      const el = buildMessageElement(msg);
      if (el) fragment.appendChild(el);
    }

    // Вставляем после sentinel (или в начало)
    const insertAfter = sentinel ? sentinel.nextSibling : container.firstChild;
    container.insertBefore(fragment, insertAfter);
  }

  // ---- Создаём DOM-элемент сообщения (используется в renderMessages и prependMessages) ----
  function buildMessageElement(msg) {
    if (msg.file_type === 'call') return null;

    const isOwn = msg.sender_id === currentUser.id;
    const timeStr = new Date(msg.created_at).toLocaleTimeString('ru-RU', {
      hour: '2-digit', minute: '2-digit'
    });

    let contentHTML = '';

    if (msg.file_url) {
      if (msg.file_type && msg.file_type.startsWith('image/')) {
        contentHTML += `
          <div class="msg-image-wrap">
            <img src="${msg.file_url}" alt="${escapeHTML(msg.file_name || 'изображение')}" class="msg-image" onclick="Chat.openImageModal('${msg.file_url}')" loading="lazy">
          </div>
        `;
      } else if (msg.file_name && msg.file_name.startsWith('vidnote_')) {
        const uid = `vn-${msg.id}`;
        contentHTML += `
          <div class="vidnote-wrap" id="${uid}">
            <div class="vidnote-clickable" onclick="Chat.toggleVidnote('${uid}')">
              <div class="vidnote-canvas-wrap">
                <video class="vidnote-video" id="${uid}-video" src="${escapeHTML(msg.file_url)}" preload="metadata" playsinline
                  onloadedmetadata="Chat.onVidnoteMetaLoaded('${uid}')"></video>
                <svg class="vidnote-ring-svg" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="48" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="2"/>
                  <circle cx="50" cy="50" r="48" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="2" stroke-linecap="round"
                    stroke-dasharray="301.6 301.6" stroke-dashoffset="301.6" id="${uid}-progress"
                    style="transform:rotate(-90deg);transform-origin:50% 50%;"/>
                </svg>
                <div class="vidnote-play-icon" id="${uid}-playicon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="6,3 20,12 6,21"/></svg>
                </div>
              </div>
            </div>
            <span class="vidnote-dur" id="${uid}-dur">Кружок</span>
          </div>
        `;
      } else if (msg.file_type && (msg.file_type.startsWith('audio/') || msg.file_type.includes('webm') || msg.file_type.includes('ogg'))) {
        const uid = `voice-${msg.id}`;
        const isVoiceMsg = !msg.file_name || msg.file_name.startsWith('voice_');
        contentHTML += `
          <div class="msg-voice">
            <button class="msg-voice-play" onclick="Chat.toggleMsgVoice('${uid}')" title="Воспроизвести">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" id="${uid}-icon"><polygon points="5,3 19,12 5,21"/></svg>
            </button>
            <div class="msg-voice-track">
              <input type="range" class="msg-voice-seek" id="${uid}-seek" min="0" max="100" value="0" step="0.1" oninput="Chat.seekMsgVoice('${uid}')">
              <div class="msg-voice-fill-bg"><div class="msg-voice-fill" id="${uid}-fill"></div></div>
            </div>
            <span class="msg-voice-dur" id="${uid}-dur">0:00</span>
            <audio id="${uid}-audio" src="${escapeHTML(msg.file_url)}" preload="metadata" style="display:none;"
              onloadedmetadata="Chat.onVoiceMetaLoaded('${uid}')"
              ontimeupdate="Chat.onVoiceTimeUpdate('${uid}')"
              onended="Chat.onVoiceEnded('${uid}')"></audio>
          </div>
          ${!isVoiceMsg ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">🎵 ${escapeHTML(msg.file_name)}</div>` : ''}
        `;
      } else {
        contentHTML += `
          <a href="${msg.file_url}" target="_blank" rel="noopener noreferrer" class="msg-file">
            <span class="msg-file-icon">${getFileIcon(msg.file_type)}</span>
            <div class="msg-file-info">
              <span class="msg-file-name">${escapeHTML(msg.file_name || 'файл')}</span>
              ${msg.file_size ? `<span class="msg-file-size">${formatFileSize(msg.file_size)}</span>` : ''}
            </div>
            <span class="msg-file-download">⬇</span>
          </a>
        `;
      }
    }

    if (msg.content) {
      const groupInviteMatchDM = msg.content.match(/^IFlashGROUP_([0-9a-f-]{36})$/);
      const channelInviteMatchDM = msg.content.match(/^IFlashCHANNEL_([0-9a-f-]{36})$/);
      if (groupInviteMatchDM) {
        const gidDM = groupInviteMatchDM[1];
        contentHTML += `<div class="msg-text group-invite-link" onclick="Chat._handleGroupInviteClick('${gidDM}')" title="Нажмите, чтобы вступить в группу">
          <span class="group-invite-icon">👥</span>
          <div>
            <span class="group-invite-text">Приглашение в группу</span>
            <span class="group-invite-sub">Нажмите, чтобы вступить</span>
          </div>
        </div>`;
      } else if (channelInviteMatchDM) {
        const cid = channelInviteMatchDM[1];
        contentHTML += `<div class="msg-text group-invite-link" onclick="if(window.Channels)Channels.handleChannelInviteClick('${cid}')" title="Нажмите, чтобы вступить в канал">
          <span class="group-invite-icon">📢</span>
          <div>
            <span class="group-invite-text">Приглашение в канал</span>
            <span class="group-invite-sub">Нажмите, чтобы вступить</span>
          </div>
        </div>`;
      } else if (window.SupportBot && window.SupportBot.parseBotMessage(msg.content)) {
        // Сообщение бота техподдержки с кнопками
        const botMsg = window.SupportBot.parseBotMessage(msg.content);
        const textHTML = botMsg.text.split('\n').map(l => escapeHTML(l)).join('<br>');
        contentHTML += `<div class="sbot-message"><div class="sbot-text">${textHTML}</div>`;
        if (botMsg.buttons && botMsg.buttons.length > 0) {
          const cols = botMsg.columns || 2;
          contentHTML += `<div class="sbot-buttons cols-${cols}">`;
          botMsg.buttons.forEach(btn => {
            contentHTML += `<button class="sbot-btn" onclick="SupportBot.handleButtonAction('${currentUser.id}', '${escapeHTML(btn.action)}')">${escapeHTML(btn.label)}</button>`;
          });
          contentHTML += `</div>`;
        }
        contentHTML += `</div>`;
      } else {
        // Проверяем, является ли сообщение пересланным
        const fwd = parseForwardedMessage(msg.content);
        if (fwd) {
          let fwdAvatarHTML = '';
          if (fwd.isChannel) {
            fwdAvatarHTML = `<span class="fwd-mini-avatar" style="font-size:16px;">📢</span>`;
          } else {
            const fwdProfile = fwd.senderId ? allProfiles.find(p => p.id === fwd.senderId) : null;
            fwdAvatarHTML = fwdProfile
              ? `<span class="fwd-mini-avatar">${getContactAvatarHTML(fwdProfile, 18)}</span>`
              : `<span class="fwd-mini-avatar">↪</span>`;
          }
          const fwdLabel = fwd.isChannel
            ? `Переслано из канала <b>${escapeHTML(fwd.senderName)}</b>`
            : `Переслано от <b>${escapeHTML(fwd.senderName)}</b>`;
          contentHTML += `
            <div class="forwarded-header">
              ${fwdAvatarHTML}
              <span class="forwarded-from-name">${fwdLabel}</span>
            </div>
            ${_renderLongText(fwd.text, msg.id + '-fwd')}
          `;
        } else {
          contentHTML += _renderLongText(msg.content, msg.id);
        }
      }
    }

    const readMark = isOwn
      ? msgTickHTML(msg.is_read ? 'read' : 'delivered')
      : '';

    // Определяем, является ли сообщение видеокружком (без пузыря)
    const isVidnoteMsg = msg.file_name && msg.file_name.startsWith('vidnote_') && !msg.content;

    const div = document.createElement('div');
    div.className = `message-wrapper ${isOwn ? 'own' : 'other'}`;
    div.dataset.msgId = msg.id;
    // Если сообщение не удалось расшифровать — сохраняем данные для reDecryptVisible()
    if (msg._encryptedContent) {
      div.setAttribute('data-encrypted-content', msg._encryptedContent);
      div.setAttribute('data-sender-id', msg._senderId || msg.sender_id);
    }

    // Плашка ответа на сообщение
    const replyPlateHTML = _buildReplyPlateHTML(msg);

    if (isVidnoteMsg) {
      // Видеокружок — без пузыря, только кружок + мета
      div.innerHTML = `
        <div class="message-bubble vidnote-bubble">
          ${contentHTML}
          <div class="msg-meta vidnote-meta">
            <span class="msg-time">${timeStr}</span>
            ${readMark}
          </div>
        </div>
        ${buildReactionBar(msg.id, isOwn)}
      `;
    } else {
      div.innerHTML = `
        <div class="message-bubble">
          ${replyPlateHTML}
          ${contentHTML}
          <div class="msg-meta">
            <span class="msg-time">${timeStr}</span>
            ${readMark}
          </div>
        </div>
        ${buildReactionBar(msg.id, isOwn)}
      `;
    }

    // Контекстное меню
    const bubble = div.querySelector('.message-bubble');
    if (bubble) {
      const textContent = msg.content || '';
      bubble.addEventListener('contextmenu', (e) => {
        showMessageContextMenu(e, msg.id, isOwn, textContent, msg.file_url, msg.file_name);
      });
      let longPressTimer = null;
      bubble.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
          showMessageContextMenu(e.touches[0], msg.id, isOwn, textContent, msg.file_url, msg.file_name);
        }, 500);
      }, { passive: true });
      bubble.addEventListener('touchend', () => { clearTimeout(longPressTimer); });
      bubble.addEventListener('touchmove', () => { clearTimeout(longPressTimer); });
    }

    return div;
  }

  // ---- Рендер сообщений ----
  async function renderMessages(messages, gen) {
    const container = getEl('messages-container');
    if (!container) return;

    // Сбрасываем Set при полной перезагрузке сообщений (смена чата)
    renderedMessageIds.clear();

    if (messages.length === 0) {
      container.innerHTML = `
        <div class="no-messages">
          <div class="no-messages-icon">👋</div>
          <p>Начните диалог! Напишите первое сообщение.</p>
        </div>
      `;
      return;
    }

    // ── E2EE: предзагрузить ключи ВСЕХ участников разговора одним запросом ──
    if (window.Encryption) {
      const allIds = [...new Set(messages.flatMap(m => [m.sender_id, m.receiver_id]).filter(Boolean))];
      await window.Encryption.preloadKeys(allIds);
    }

    // Проверяем поколение — вдруг переключились пока грузились ключи
    if (gen !== undefined && gen !== _chatLoadGen) return;

    // ── E2EE: расшифровать все сообщения параллельно ──────────────
    const decryptedMessages = window.Encryption
      ? await Promise.all(messages.map(decryptMsg))
      : messages;

    // Последняя проверка перед записью в DOM
    if (gen !== undefined && gen !== _chatLoadGen) return;

    container.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let prevDate = null;

    for (let i = 0; i < decryptedMessages.length; i++) {
      const msg = decryptedMessages[i];
      const msgDate = new Date(msg.created_at).toLocaleDateString('ru-RU', {
        day: 'numeric', month: 'long', year: 'numeric'
      });

      if (msgDate !== prevDate) {
        const divider = document.createElement('div');
        divider.className = 'date-divider';
        divider.innerHTML = `<span>${msgDate}</span>`;
        fragment.appendChild(divider);
        prevDate = msgDate;
      }

      if (msg.file_type === 'call') continue;
      renderedMessageIds.add(msg.id);

      const el = buildMessageElement(msg);
      if (el) fragment.appendChild(el);
    }

    container.appendChild(fragment);

    // Загружаем реакции для всех сообщений
    const ids = messages.map((m) => m.id);
    loadReactionsForMessages(ids);

    // Применяем Twemoji ко всем текстам сообщений
    requestAnimationFrame(() => {
      container.querySelectorAll('.msg-text').forEach(el => _applyTwemoji(el));
    });

    // Прокручиваем вниз
    scrollToBottom(container);
  }

  // ── E2EE: расшифровать одно сообщение (возвращает копию с plaintext) ──
  async function decryptMsg(msg) {
    if (!msg.content || !window.Encryption || !window.Encryption.isEncrypted(msg.content)) {
      return msg;
    }
    // Для ECDH: «другая сторона» = не я. Если я отправитель → другая сторона = receiver, и наоборот.
    const otherId = msg.sender_id === currentUser?.id ? msg.receiver_id : msg.sender_id;
    const plain = await window.Encryption.decryptFrom(msg.content, otherId);
    // Если расшифровка не удалась — возвращаем маркер и сохраняем исходный зашифрованный контент
    // в атрибуте для последующей перерасшифровки (reDecryptVisible)
    if (plain && plain.startsWith('__E2EE__')) {
      return {
        ...msg,
        content: '🔒 Зашифрованное сообщение',
        _encryptedContent: msg.content,  // для reDecryptVisible
        _senderId: msg.sender_id,
      };
    }
    return { ...msg, content: plain };
  }

  // ---- Добавление одного сообщения (Realtime) ----
  async function appendMessage(msg) {
    const container = getEl('messages-container');
    if (!container) return;

    // Защита от дублирования: если сообщение уже отрисовано — пропускаем
    if (renderedMessageIds.has(msg.id)) return;
    renderedMessageIds.add(msg.id);

    // Убираем заглушку "нет сообщений"
    const noMessages = container.querySelector('.no-messages');
    if (noMessages) noMessages.remove();

    if (msg.file_type === 'call') return;

    // ── E2EE расшифровка перед рендером ──────────────────────────
    const displayMsg = await decryptMsg(msg);

    const div = buildMessageElement(displayMsg);
    if (!div) return;
    div.classList.add('msg-animate');
    container.appendChild(div);
    // Apply twemoji to message text
    const textEl = div.querySelector('.msg-text');
    if (textEl) _applyTwemoji(textEl);
    scrollToBottom(container);
  }

  function scrollToBottom(container) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }

  // ============================================================
  // РЕАКЦИИ НА СООБЩЕНИЯ
  // ============================================================

  // ---- Построить HTML панели реакций под сообщением ----
  function buildReactionBar(msgId, isOwn) {
    return `
      <div class="reaction-bar" data-msg-id="${msgId}">
        <div class="reaction-counts" id="rcounts-${msgId}"></div>
        <div class="reaction-picker-wrap">
          <button class="reaction-quick-trigger" onclick="Chat.toggleReactionPicker('${msgId}', event)" aria-label="Реакция">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
          </button>
          <div class="reaction-picker" id="rpicker-${msgId}" style="display:none;">
            <div class="reaction-picker-quick">
              ${QUICK_EMOJI.map(e => `<button class="reaction-emoji-btn" onclick="Chat.addReaction('${msgId}','${e}')">${e}</button>`).join('')}
              <button class="reaction-expand-btn" onclick="Chat.toggleReactionPickerExpand('${msgId}')" title="Все эмодзи">＋</button>
            </div>
            <div class="reaction-picker-full" id="rfull-${msgId}" style="display:none;">
              ${ALL_EMOJI.map(e => `<button class="reaction-emoji-btn" onclick="Chat.addReaction('${msgId}','${e}')">${e}</button>`).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ---- Открыть/закрыть пикер реакций для сообщения ----
  let _reactionPickerBusy = false;
  function toggleReactionPicker(msgId, e) {
    e.stopPropagation();
    e.preventDefault();
    // Защита от быстрых кликов
    if (_reactionPickerBusy) return;
    _reactionPickerBusy = true;
    setTimeout(() => { _reactionPickerBusy = false; }, 300);
    // На мобильных: убираем фокус с инпута чтобы клавиатура не появлялась
    if (document.activeElement && (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT')) {
      document.activeElement.blur();
    }
    // Анимация улыбки кнопки
    const triggerBtn = e.currentTarget || e.target;
    if (triggerBtn && triggerBtn.classList.contains('reaction-quick-trigger')) {
      triggerBtn.classList.remove('anim-smile');
      void triggerBtn.offsetWidth;
      triggerBtn.classList.add('anim-smile');
      triggerBtn.addEventListener('animationend', () => triggerBtn.classList.remove('anim-smile'), { once: true });
    }
    const picker = getEl(`rpicker-${msgId}`);
    if (!picker) return;
    // Закрываем все открытые пикеры
    document.querySelectorAll('.reaction-picker').forEach((p) => {
      if (p.id !== `rpicker-${msgId}`) {
        p.style.display = 'none';
        p.classList.remove('reaction-picker--sheet');
        const full = p.querySelector('.reaction-picker-full');
        if (full) full.style.display = 'none';
      }
    });
    if (picker.style.display !== 'none' && picker.style.display !== '') {
      picker.style.display = 'none';
      picker.classList.remove('reaction-picker--sheet');
      return;
    }

    if (_isMobile || _isTablet || _isCapacitor) {
      // ===== МОБИЛЬНАЯ ВЕРСИЯ: bottom-sheet =====
      picker.style.cssText = '';
      picker.classList.add('reaction-picker--sheet');
      picker.style.display = 'block';
      _applyTwemoji(picker);
    } else {
      // ===== ДЕСКТОП: floating popup над кнопкой =====
      picker.classList.remove('reaction-picker--sheet');
      const btn = e.currentTarget || e.target;
      const rect = btn.getBoundingClientRect();
      picker.style.position = 'fixed';
      picker.style.display = 'block';
      picker.style.left = '0';
      picker.style.top = '-9999px';
      requestAnimationFrame(() => {
        const ph = picker.offsetHeight;
        const pw = picker.offsetWidth;
        let x = rect.left;
        let y = rect.top - ph - 6;
        if (x + pw > window.innerWidth - 8) x = window.innerWidth - pw - 8;
        if (x < 8) x = 8;
        if (y < 8) y = 8;
        picker.style.left = x + 'px';
        picker.style.top = y + 'px';
        _applyTwemoji(picker);
      });
    }
  }

  // ---- Развернуть все эмодзи ----
  function toggleReactionPickerExpand(msgId) {
    const full = getEl(`rfull-${msgId}`);
    if (!full) return;
    full.style.display = full.style.display === 'none' ? 'grid' : 'none';
  }

  // ---- Закрыть все пикеры при клике вне ----
  function closeAllReactionPickers() {
    document.querySelectorAll('.reaction-picker').forEach((p) => {
      p.style.display = 'none';
      p.classList.remove('reaction-picker--sheet');
      const full = p.querySelector('.reaction-picker-full');
      if (full) full.style.display = 'none';
    });
  }

  // ---- Добавить / убрать реакцию (toggle) ----
  let _reactionBusy = false;
  async function addReaction(msgId, emoji) {
    // Блокируем повторные клики пока идёт запрос
    if (_reactionBusy) return;
    _reactionBusy = true;

    // Закрываем пикер
    closeAllReactionPickers();

    if (!currentUser) { _reactionBusy = false; return; }

    try {
      // Смотрим, есть ли уже реакция от этого пользователя на это сообщение
      const { data: existing } = await window.supabaseClient
        .from('message_reactions')
        .select('id, emoji')
        .eq('message_id', msgId)
        .eq('user_id', currentUser.id)
        .maybeSingle();

      if (existing) {
        if (existing.emoji === emoji) {
          // Та же реакция — убираем (toggle off)
          await window.supabaseClient
            .from('message_reactions')
            .delete()
            .eq('id', existing.id);
        } else {
          // Другая реакция — заменяем (update)
          await window.supabaseClient
            .from('message_reactions')
            .update({ emoji })
            .eq('id', existing.id);
        }
      } else {
        // Новая реакция
        await window.supabaseClient
          .from('message_reactions')
          .insert({ message_id: msgId, user_id: currentUser.id, emoji });
      }

      // Перерисовываем счётчики для этого сообщения
      await refreshReactionCounts(msgId);
    } catch (err) {
      console.error('Ошибка реакции:', err);
    } finally {
      _reactionBusy = false;
    }
  }

  // ---- Загрузить реакции для списка сообщений ----
  async function loadReactionsForMessages(messageIds) {
    if (!messageIds || messageIds.length === 0) return;
    try {
      const { data, error } = await window.supabaseClient
        .from('message_reactions')
        .select('message_id, emoji, user_id')
        .in('message_id', messageIds);

      if (error) { console.error('Ошибка загрузки реакций:', error); return; }

      // Строим кэш: { msgId: { emoji: Set(userId) } }
      reactionsCache = {};
      (data || []).forEach(({ message_id, emoji, user_id }) => {
        if (!reactionsCache[message_id]) reactionsCache[message_id] = {};
        if (!reactionsCache[message_id][emoji]) reactionsCache[message_id][emoji] = new Set();
        reactionsCache[message_id][emoji].add(user_id);
      });

      // Рендерим счётчики для всех сообщений
      messageIds.forEach((id) => renderReactionCounts(id));
    } catch (err) {
      console.error('Ошибка:', err);
    }
  }

  // ---- Обновить счётчики одного сообщения (после toggle) ----
  async function refreshReactionCounts(msgId) {
    try {
      const { data, error } = await window.supabaseClient
        .from('message_reactions')
        .select('emoji, user_id')
        .eq('message_id', msgId);

      if (error) return;

      reactionsCache[msgId] = {};
      (data || []).forEach(({ emoji, user_id }) => {
        if (!reactionsCache[msgId][emoji]) reactionsCache[msgId][emoji] = new Set();
        reactionsCache[msgId][emoji].add(user_id);
      });

      renderReactionCounts(msgId);
    } catch (err) {
      console.error('Ошибка обновления реакций:', err);
    }
  }

  // ---- Рендер счётчиков реакций под сообщением ----
  function renderReactionCounts(msgId) {
    const container = getEl(`rcounts-${msgId}`);
    if (!container) return;

    const reactions = reactionsCache[msgId] || {};
    const entries = Object.entries(reactions).filter(([, users]) => users.size > 0);

    if (entries.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = entries.map(([emoji, users]) => {
      const count = users.size;
      const isMine = currentUser && users.has(currentUser.id);

      // Строим стек аватарок (максимум 3)
      const userIds = [...users].slice(0, 3);
      const avatarStackHTML = userIds.map(uid => {
        const profile = uid === currentUser?.id ? currentProfile : allProfiles.find(p => p.id === uid);
        if (profile && profile.avatar_url) {
          return `<img src="${profile.avatar_url}" class="reaction-avatar" style="width:18px;height:18px;border-radius:50%;object-fit:cover;border:1.5px solid var(--bg-secondary);margin-right:-5px;flex-shrink:0;" alt="">`;
        }
        const displayStr = profile ? getDisplayName(profile) : '?';
        const initial = displayStr.charAt(0).toUpperCase();
        const colors = ['#6C63FF','#FF6584','#43B89C','#F9A825','#EF5350','#42A5F5','#AB47BC','#26A69A'];
        const bg = profile ? colors[profile.username.charCodeAt(0) % colors.length] : '#6C63FF';
        return `<div class="reaction-avatar-placeholder" style="width:18px;height:18px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;font-size:8px;color:white;font-weight:700;border:1.5px solid var(--bg-secondary);margin-right:-5px;flex-shrink:0;">${initial}</div>`;
      }).join('');

      return `
        <button
          class="reaction-count-chip ${isMine ? 'mine' : ''}"
          onclick="Chat.addReaction('${msgId}','${emoji}')"
          title="${isMine ? 'Убрать реакцию' : 'Добавить реакцию'}"
        >
          <div class="reaction-avatars-stack" style="display:flex;align-items:center;padding-right:3px;">${avatarStackHTML}</div>
          <span class="reaction-emoji-display">${emoji}</span>
          <span class="reaction-chip-count">${count}</span>
        </button>
      `;
    }).join('');

    // Применяем twemoji к чипам реакций (на десктопе/Electron)
    _applyTwemoji(container);
  }

  // ---- Realtime-подписка на реакции ----
  function subscribeToReactions() {
    if (reactionsSubscription) {
      window.supabaseClient.removeChannel(reactionsSubscription);
    }
    reactionsSubscription = window.supabaseClient
      .channel('reactions-global')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, (payload) => {
        const msgId = payload.new?.message_id || payload.old?.message_id;
        if (!msgId) return;
        // Сообщение не видно — игнорируем
        const el = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (!el) return;

        // Обновляем кэш напрямую из payload — без лишнего запроса в БД
        if (!reactionsCache[msgId]) reactionsCache[msgId] = {};

        if (payload.eventType === 'INSERT' && payload.new) {
          const { emoji, user_id } = payload.new;
          if (!reactionsCache[msgId][emoji]) reactionsCache[msgId][emoji] = new Set();
          reactionsCache[msgId][emoji].add(user_id);
          renderReactionCounts(msgId);
        } else if (payload.eventType === 'DELETE') {
          if (payload.old && payload.old.emoji && payload.old.user_id) {
            // REPLICA IDENTITY FULL — данные есть в payload.old
            const { emoji, user_id } = payload.old;
            if (reactionsCache[msgId][emoji]) {
              reactionsCache[msgId][emoji].delete(user_id);
              if (reactionsCache[msgId][emoji].size === 0) delete reactionsCache[msgId][emoji];
            }
            renderReactionCounts(msgId);
          } else {
            // Нет REPLICA IDENTITY FULL — перечитываем реакции из БД
            window.supabaseClient
              .from('message_reactions').select('emoji,user_id').eq('message_id', msgId)
              .then(({ data }) => {
                reactionsCache[msgId] = {};
                (data || []).forEach(r => {
                  if (!reactionsCache[msgId][r.emoji]) reactionsCache[msgId][r.emoji] = new Set();
                  reactionsCache[msgId][r.emoji].add(r.user_id);
                });
                renderReactionCounts(msgId);
              });
          }
        } else if (payload.eventType === 'UPDATE' && payload.new && payload.old) {
          const { emoji: oldEmoji, user_id } = payload.old;
          const { emoji: newEmoji } = payload.new;
          if (reactionsCache[msgId][oldEmoji]) {
            reactionsCache[msgId][oldEmoji].delete(user_id);
            if (reactionsCache[msgId][oldEmoji].size === 0) delete reactionsCache[msgId][oldEmoji];
          }
          if (!reactionsCache[msgId][newEmoji]) reactionsCache[msgId][newEmoji] = new Set();
          reactionsCache[msgId][newEmoji].add(user_id);
          renderReactionCounts(msgId);
        }
      })
      .subscribe();
  }

  // ---- Периодический polling реакций (fallback) ----
  let _reactionsPollInterval = null;

  function _startReactionsPolling() {
    if (_reactionsPollInterval) clearInterval(_reactionsPollInterval);
    // Poll every 15s (was 8s) — realtime handles live updates; polling is just a safety net
    _reactionsPollInterval = setInterval(_pollVisibleReactions, 15000);
  }

  async function _pollVisibleReactions() {
    // Skip polling when app is in background (saves CPU/network)
    if (document.hidden) return;
    const visibleMsgs = document.querySelectorAll('[data-msg-id]');
    if (!visibleMsgs.length) return;
    // Limit to at most 50 messages to avoid large queries
    const ids = [];
    visibleMsgs.forEach(el => {
      if (ids.length >= 50) return;
      const id = el.getAttribute('data-msg-id');
      if (id) ids.push(id);
    });
    if (!ids.length) return;
    try {
      const { data } = await window.supabaseClient
        .from('message_reactions').select('message_id,emoji,user_id').in('message_id', ids);
      if (!data) return;
      // Пересобираем кэш для видимых сообщений
      const fresh = {};
      data.forEach(r => {
        if (!fresh[r.message_id]) fresh[r.message_id] = {};
        if (!fresh[r.message_id][r.emoji]) fresh[r.message_id][r.emoji] = new Set();
        fresh[r.message_id][r.emoji].add(r.user_id);
      });
      ids.forEach(id => {
        const prev = JSON.stringify(Object.entries(reactionsCache[id] || {}).map(([e, s]) => [e, [...s].sort()]));
        const next = JSON.stringify(Object.entries(fresh[id] || {}).map(([e, s]) => [e, [...s].sort()]));
        if (prev !== next) {
          reactionsCache[id] = fresh[id] || {};
          renderReactionCounts(id);
        }
      });
    } catch {}
  }

  // ---- Отправка сообщения ----
  // ================================================================
  //  UPLOAD ANIMATION
  // ================================================================
  let _uploadAbortController = null;
  let _uploadCancelled = false;

  function showUploadIndicator() {
    const ind = getEl('upload-indicator');
    const sendBtn = getEl('send-btn');
    const micBtn = getEl('mic-btn');
    if (ind) ind.style.display = 'flex';
    if (sendBtn) sendBtn.style.display = 'none';
    if (micBtn) micBtn.style.display = 'none';
    _uploadCancelled = false;
    _uploadAbortController = new AbortController();
  }

  function hideUploadIndicator() {
    const ind = getEl('upload-indicator');
    if (ind) ind.style.display = 'none';
    _uploadAbortController = null;
    updateSendBtnVisibility();
  }

  function cancelUpload() {
    _uploadCancelled = true;
    if (_uploadAbortController) {
      _uploadAbortController.abort();
      _uploadAbortController = null;
    }
    hideUploadIndicator();
    showToast('Загрузка отменена', 'info');
  }

  // ================================================================
  //  SEND BUTTON / MIC BUTTON VISIBILITY
  // ================================================================
  function updateSendBtnVisibility() {
    const input = getEl('message-input');
    const sendBtn = getEl('send-btn');
    const micBtn = getEl('mic-btn');
    if (!sendBtn || !micBtn) return;
    const hasContent = (input && input.value.trim().length > 0) || !!selectedFile || selectedFiles.length > 0 || !!voiceBlob;
    sendBtn.style.display = hasContent ? '' : 'none';
    micBtn.style.display = hasContent ? 'none' : '';
  }

  // ================================================================
  //  VOICE RECORDING
  // ================================================================
  function toggleVoiceModePicker() {
    const bar = getEl('voice-mode-bar');
    const inputRow = document.querySelector('.input-row');
    if (!bar || !inputRow) return;
    const isVisible = bar.style.display !== 'none';
    if (isVisible) {
      hideVoiceModeBar();
    } else {
      bar.style.display = 'flex';
      inputRow.style.display = 'none';
    }
  }

  function hideVoiceModeBar() {
    const bar = getEl('voice-mode-bar');
    const inputRow = document.querySelector('.input-row');
    if (bar) bar.style.display = 'none';
    if (inputRow) inputRow.style.display = '';
  }

  async function startVoiceRecording() {
    hideVoiceModeBar();
    if (mediaRecorder && mediaRecorder.state === 'recording') return;
    try {
      // 24kHz достаточно для голоса, Opus эффективно сжимает речь
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 24000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/ogg;codecs=opus';

      audioChunks = [];
      // 32kbps достаточно для разборчивой речи с Opus
      mediaRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });

      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        voiceBlob = new Blob(audioChunks, { type: mimeType });
        showVoicePreview(voiceBlob);
      };

      mediaRecorder.start(100);
      voiceStartTime = Date.now();

      const panel = getEl('voice-recording-panel');
      if (panel) {
        panel.style.display = 'flex';
        panel.innerHTML = `
          <div class="voice-rec-dot"></div>
          <span class="voice-rec-label">Запись...</span>
          <span class="voice-rec-timer" id="voice-timer">0:00</span>
          <button class="voice-rec-stop-btn" onclick="Chat.stopVoiceRecording()" title="Стоп" style="padding:6px 12px;background:#ef5350;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">Стоп</button>
          <button class="voice-rec-cancel" onclick="Chat.cancelVoiceRecording()" title="Отмена">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        `;
      }
      const micBtn = getEl('mic-btn');
      if (micBtn) micBtn.classList.add('recording');

      if (voiceTimerInterval) clearInterval(voiceTimerInterval);
      voiceTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - voiceStartTime) / 1000);
        const m = Math.floor(elapsed / 60), s = elapsed % 60;
        const t = getEl('voice-timer');
        if (t) t.textContent = `${m}:${s.toString().padStart(2, '0')}`;
      }, 500);

      setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') stopVoiceRecording();
      }, MAX_VOICE_DURATION);

    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        showToast('Нет разрешения на микрофон. Разрешите доступ в настройках приложения.', 'error');
      } else if (name === 'NotFoundError') {
        showToast('Микрофон не найден на этом устройстве.', 'error');
      } else {
        showToast('Ошибка микрофона: ' + (err?.message || 'неизвестная ошибка'), 'error');
      }
    }
  }

  function stopVoiceRecording() {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
    voiceDuration = Math.floor((Date.now() - voiceStartTime) / 1000);
    clearInterval(voiceTimerInterval);
    mediaRecorder.stop();
    const panel = getEl('voice-recording-panel');
    if (panel) panel.style.display = 'none';
    const micBtn = getEl('mic-btn');
    if (micBtn) micBtn.classList.remove('recording');
  }

  function cancelVoiceRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.ondataavailable = null;
      const origStop = mediaRecorder.onstop;
      mediaRecorder.onstop = (e) => { try { origStop && origStop.call(mediaRecorder, e); } catch {} };
      mediaRecorder.onstop = () => {
        try { mediaRecorder.stream && mediaRecorder.stream.getTracks().forEach(t => t.stop()); } catch {}
      };
      try { mediaRecorder.stop(); } catch {}
    }
    clearInterval(voiceTimerInterval);
    voiceBlob = null;
    audioChunks = [];
    const panel = getEl('voice-recording-panel');
    if (panel) panel.style.display = 'none';
    const micBtn = getEl('mic-btn');
    if (micBtn) micBtn.classList.remove('recording');
    clearVoicePreview();
    updateSendBtnVisibility();
  }

  function showVoicePreview(blob) {
    const filePreview = getEl('file-preview');
    if (!filePreview) return;
    const url = URL.createObjectURL(blob);
    const m = Math.floor(voiceDuration / 60), s = voiceDuration % 60;
    const durStr = `${m}:${s.toString().padStart(2, '0')}`;
    filePreview.classList.add('visible');
    filePreview.innerHTML = `
      <div class="voice-preview">
        <div class="voice-preview-left">
          <button class="voice-play-btn" id="voice-play-btn" onclick="Chat.toggleVoicePreviewPlay()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" id="voice-play-icon"><polygon points="5,3 19,12 5,21"/></svg>
          </button>
          <div class="voice-preview-waveform">
            <input type="range" class="voice-seek" id="voice-seek" min="0" max="100" value="0" step="0.1">
            <div class="voice-seek-track"><div class="voice-seek-fill" id="voice-seek-fill"></div></div>
          </div>
          <span class="voice-preview-dur" id="voice-preview-dur">${durStr}</span>
        </div>
        <div class="voice-preview-actions">
          <button class="voice-send-btn" onclick="Chat.sendVoiceMessage()" title="Отправить">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9l20-7z"/></svg>
          </button>
          <button class="voice-del-btn" onclick="Chat.cancelVoiceRecording()" title="Удалить">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
        <audio id="voice-preview-audio" src="${url}" preload="metadata" style="display:none;"></audio>
      </div>
    `;
    const audio = getEl('voice-preview-audio');
    const seekEl = getEl('voice-seek');
    const fillEl = getEl('voice-seek-fill');
    const durEl = getEl('voice-preview-dur');
    const playIcon = getEl('voice-play-icon');
    if (audio && seekEl) {
      audio.addEventListener('timeupdate', () => {
        if (!audio.duration) return;
        const pct = (audio.currentTime / audio.duration) * 100;
        seekEl.value = pct;
        if (fillEl) fillEl.style.width = pct + '%';
        const rem = Math.floor(audio.duration - audio.currentTime);
        if (durEl) durEl.textContent = `${Math.floor(rem/60)}:${(rem%60).toString().padStart(2,'0')}`;
      });
      seekEl.addEventListener('input', () => {
        if (audio.duration) audio.currentTime = (seekEl.value / 100) * audio.duration;
      });
      audio.addEventListener('ended', () => {
        if (playIcon) playIcon.innerHTML = '<polygon points="5,3 19,12 5,21"/>';
        seekEl.value = 0;
        if (fillEl) fillEl.style.width = '0%';
        if (durEl) durEl.textContent = durStr;
      });
    }
    updateSendBtnVisibility();
  }

  function toggleVoicePreviewPlay() {
    const audio = getEl('voice-preview-audio');
    const playIcon = getEl('voice-play-icon');
    if (!audio) return;
    if (audio.paused) {
      audio.play();
      if (playIcon) playIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
      audio.pause();
      if (playIcon) playIcon.innerHTML = '<polygon points="5,3 19,12 5,21"/>';
    }
  }

  function clearVoicePreview() {
    const fp = getEl('file-preview');
    if (fp) { fp.classList.remove('visible'); fp.innerHTML = ''; }
    voiceBlob = null;
  }

  async function sendVoiceMessage() {
    if (!voiceBlob) return;
    const inChannel = window.Channels && window.Channels.selectedChannel;
    const inDM = selectedChat && !inChannel;
    if (!inDM && !inChannel) { showToast('Выберите чат для отправки', 'error'); return; }
    showUploadIndicator();
    try {
      const mimeType = voiceBlob.type;
      const ext = mimeType.includes('webm') ? 'webm' : 'ogg';
      const filePath = inDM
        ? `${currentUser.id}/dm_${selectedChat.id}/voice_${Date.now()}.${ext}`
        : `${currentUser.id}/ch_${inChannel.id}/voice_${Date.now()}.${ext}`;
      const { error: uploadError } = await window.supabaseClient.storage
        .from('chat-files')
        .upload(filePath, voiceBlob, { cacheControl: '3600', upsert: false, contentType: mimeType });
      if (uploadError) { showToast('Ошибка загрузки: ' + uploadError.message, 'error'); return; }
      const { data: urlData } = window.supabaseClient.storage.from('chat-files').getPublicUrl(filePath);
      const fileName = `voice_${Date.now()}.${ext}`;
      if (inChannel) {
        const isAdmin = window.Channels.channels && window.Channels.channels.find(c => c.id === inChannel.id)?.my_role === 'admin';
        if (!isAdmin) { showToast('Только администраторы могут писать в канал', 'error'); return; }
        await window.supabaseClient.from('channel_messages').insert({
          channel_id: inChannel.id,
          sender_id: currentUser.id,
          content: null,
          file_url: urlData.publicUrl,
          file_name: fileName,
          file_type: mimeType,
          file_size: voiceBlob.size
        });
      } else {
        const { data: msgData, error: msgError } = await window.supabaseClient
          .from('messages')
          .insert({
            sender_id: currentUser.id, receiver_id: selectedChat.id, content: null,
            file_url: urlData.publicUrl,
            file_name: fileName,
            file_type: mimeType,
            file_size: voiceBlob.size
          })
          .select().single();
        if (msgError) { showToast('Ошибка отправки: ' + msgError.message, 'error'); return; }
        appendMessage(msgData);
      }
      clearVoicePreview();
      loadConversations();
    } catch (err) {
      showToast('Ошибка отправки голосового', 'error');
    } finally {
      hideUploadIndicator();
    }
  }

  // ================================================================
  //  VIDEO NOTE RECORDING (видеокружки)
  // ================================================================
  // Показывает модальное окно выбора камеры, возвращает индекс или null
  // devices — массив объектов { label, deviceId, index }
  function _showCameraPickerModal(devices) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'camera-picker-overlay';
      overlay.innerHTML = `
        <div class="camera-picker-modal">
          <h3>Выберите камеру</h3>
          <div class="camera-picker-list">
            ${devices.map((d, i) => `
              <button class="camera-picker-item" data-idx="${i}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                </svg>
                ${d.label || ('Камера ' + (i + 1))}
              </button>
            `).join('')}
          </div>
          <button class="camera-picker-cancel">Отмена</button>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelectorAll('.camera-picker-item').forEach(btn => {
        btn.onclick = () => {
          document.body.removeChild(overlay);
          resolve(devices[parseInt(btn.dataset.idx)]);
        };
      });
      overlay.querySelector('.camera-picker-cancel').onclick = () => { document.body.removeChild(overlay); resolve(null); };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(null); } });
    });
  }

  async function startVideoNoteRecording() {
    hideVoiceModeBar();
    if (vidnoteRecorder && vidnoteRecorder.state === 'recording') return;
    try {
      let stream;

      // ── Шаг 1: Запрашиваем разрешение, чтобы браузер показал реальные deviceId и label ──
      // Если разрешения уже есть — enumerateDevices сразу вернёт полные данные.
      // Если нет — getUserMedia покажет диалог разрешения и после него enumerate сработает.
      let videoDevices = [];
      try {
        // Сначала пробуем перечислить без разрешения — смотрим сколько камер
        const preList = await navigator.mediaDevices.enumerateDevices();
        const preVideo = preList.filter(d => d.kind === 'videoinput');

        // Если deviceId пустой — разрешения нет, запрашиваем
        if (preVideo.length === 0 || preVideo.every(d => !d.deviceId)) {
          const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          tempStream.getTracks().forEach(t => t.stop());
        }

        // Теперь enumerate с реальными ID и названиями
        const fullList = await navigator.mediaDevices.enumerateDevices();
        videoDevices = fullList.filter(d => d.kind === 'videoinput' && d.deviceId);
      } catch {
        // Нет разрешения или камер — попробуем запустить напрямую
      }

      // ── Шаг 2: Выбор камеры ──
      let chosenDevice = null;
      if (videoDevices.length > 1) {
        // Несколько камер (напр. физическая + OBS Virtual Camera) — показываем выбор
        chosenDevice = await _showCameraPickerModal(videoDevices);
        if (chosenDevice === null) return; // пользователь отменил
      } else if (videoDevices.length === 1) {
        chosenDevice = videoDevices[0];
      }

      // ── Шаг 3: Получаем поток для выбранной камеры ──
      if (chosenDevice && chosenDevice.deviceId) {
        // Конкретная камера по deviceId
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: chosenDevice.deviceId }, width: { ideal: 480 }, height: { ideal: 480 } },
          audio: true
        });
      } else {
        // Нет конкретного ID — пробуем любую доступную камеру
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 480 }, height: { ideal: 480 } },
            audio: true
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        }
      }
      vidnoteChunks = [];
      vidnoteStream = stream;
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : 'video/webm';

      vidnoteRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 600_000,   // 600 Kbps — лёгкий файл + хорошее качество для кружка
        audioBitsPerSecond: 24_000,    // 24kbps Opus для голоса
      });
      vidnoteRecorder.ondataavailable = (e) => { if (e.data.size > 0) vidnoteChunks.push(e.data); };
      vidnoteRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        vidnoteBlob = new Blob(vidnoteChunks, { type: mimeType });
        showVideoNotePreview(vidnoteBlob);
      };

      vidnoteRecorder.start(100);
      vidnoteStartTime = Date.now();

      const panel = getEl('voice-recording-panel');
      if (panel) {
        panel.style.display = 'flex';
        panel.innerHTML = `
          <div class="vidnote-rec-wrap">
            <div class="vidnote-rec-circle">
              <video id="vidnote-preview-video" autoplay muted playsinline></video>
              <svg class="vidnote-rec-ring-svg" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="5"/>
                <circle cx="50" cy="50" r="44" fill="none" stroke="white" stroke-width="5"
                  stroke-linecap="round" stroke-dasharray="276 276" stroke-dashoffset="276"
                  id="vidnote-rec-ring-progress" style="transform:rotate(-90deg);transform-origin:50% 50%;transition:stroke-dashoffset 0.3s linear;"/>
              </svg>
            </div>
            <span id="vidnote-rec-timer">0:00</span>
            <button onclick="Chat.stopVideoNoteRecording()" class="vidnote-rec-stop-btn" title="Стоп">■</button>
            <button onclick="Chat.cancelVideoNoteRecording()" class="voice-rec-cancel" title="Отмена">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        `;
        const vidEl = getEl('vidnote-preview-video');
        if (vidEl) vidEl.srcObject = stream;
      }

      const micBtn = getEl('mic-btn');
      if (micBtn) micBtn.classList.add('recording');

      if (vidnoteTimerInterval) clearInterval(vidnoteTimerInterval);
      vidnoteTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - vidnoteStartTime) / 1000);
        const m = Math.floor(elapsed / 60), s = elapsed % 60;
        const t = getEl('vidnote-rec-timer');
        if (t) t.textContent = `${m}:${s.toString().padStart(2, '0')}`;
        const ringEl = getEl('vidnote-rec-ring-progress');
        if (ringEl) {
          const pct = Math.min(elapsed / 60, 1);
          ringEl.style.strokeDashoffset = 276 * (1 - pct);
        }
      }, 100);

      setTimeout(() => {
        if (vidnoteRecorder && vidnoteRecorder.state === 'recording') stopVideoNoteRecording();
      }, MAX_VIDNOTE_DURATION);

    } catch (err) {
      // Гарантированно освобождаем камеру/микрофон при любой ошибке
      if (vidnoteStream) {
        vidnoteStream.getTracks().forEach(t => t.stop());
        vidnoteStream = null;
      }
      const name = err && err.name;
      const msg = name === 'NotFoundError'
        ? 'Камера не найдена. Подключите веб-камеру или запустите OBS Virtual Camera.'
        : name === 'NotAllowedError' || name === 'PermissionDeniedError'
        ? 'Нет разрешения на камеру/микрофон. Разрешите доступ в настройках браузера и обновите страницу.'
        : name === 'NotReadableError'
        ? 'Камера занята другим приложением. Закройте его и попробуйте снова.'
        : `Ошибка камеры: ${err?.message || name || 'неизвестная ошибка'}`;
      showToast(msg, 'error');
      const p = getEl('voice-recording-panel');
      if (p) p.style.display = 'none';
      const micBtn = getEl('mic-btn');
      if (micBtn) micBtn.classList.remove('recording');
    }
  }

  function stopVideoNoteRecording() {
    if (!vidnoteRecorder || vidnoteRecorder.state !== 'recording') return;
    vidnoteDuration = Math.floor((Date.now() - vidnoteStartTime) / 1000);
    clearInterval(vidnoteTimerInterval);
    vidnoteRecorder.stop();
    const panel = getEl('voice-recording-panel');
    if (panel) panel.style.display = 'none';
    const micBtn = getEl('mic-btn');
    if (micBtn) micBtn.classList.remove('recording');
  }

  function cancelVideoNoteRecording() {
    if (vidnoteRecorder && vidnoteRecorder.state === 'recording') {
      vidnoteRecorder.stop();
    }
    if (vidnoteStream) {
      vidnoteStream.getTracks().forEach(t => t.stop());
    }
    clearInterval(vidnoteTimerInterval);
    vidnoteBlob = null;
    vidnoteChunks = [];
    vidnoteStream = null;
    const panel = getEl('voice-recording-panel');
    if (panel) panel.style.display = 'none';
    const micBtn = getEl('mic-btn');
    if (micBtn) micBtn.classList.remove('recording');
    const filePreview = getEl('file-preview');
    if (filePreview) { filePreview.classList.remove('visible'); filePreview.innerHTML = ''; }
    updateSendBtnVisibility();
  }

  function showVideoNotePreview(blob) {
    const filePreview = getEl('file-preview');
    if (!filePreview) return;
    const url = URL.createObjectURL(blob);
    const m = Math.floor(vidnoteDuration / 60), s = vidnoteDuration % 60;
    const durStr = `${m}:${s.toString().padStart(2, '0')}`;
    filePreview.classList.add('visible');
    filePreview.innerHTML = `
      <div class="vidnote-preview-wrap">
        <div class="vidnote-prev-circle">
          <video id="vidnote-prev-video" src="${url}" loop muted playsinline></video>
        </div>
        <span>Видеокружок • ${durStr}</span>
        <div class="voice-preview-actions">
          <button class="voice-send-btn" onclick="Chat.sendVideoNote()" title="Отправить">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9l20-7z"/></svg>
          </button>
          <button class="voice-del-btn" onclick="Chat.cancelVideoNoteRecording()" title="Удалить">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
      </div>
    `;
    updateSendBtnVisibility();
  }

  async function sendVideoNote() {
    if (!vidnoteBlob) return;
    const inChannel = window.Channels && window.Channels.selectedChannel;
    const inDM = selectedChat && !inChannel;
    if (!inDM && !inChannel) { showToast('Выберите чат для отправки', 'error'); return; }

    showUploadIndicator();
    try {
      const inChatId = inDM ? selectedChat.id : (inChannel ? inChannel.id : 'unknown');
      const filePath = inDM
        ? `${currentUser.id}/dm_${selectedChat.id}/vidnote_${Date.now()}.webm`
        : `${currentUser.id}/ch_${inChatId}/vidnote_${Date.now()}.webm`;
      const { error: uploadError } = await window.supabaseClient.storage
        .from('chat-files')
        .upload(filePath, vidnoteBlob, { cacheControl: '3600', upsert: false, contentType: 'video/webm' });
      if (uploadError) { showToast('Ошибка загрузки: ' + uploadError.message, 'error'); return; }
      const { data: urlData } = window.supabaseClient.storage.from('chat-files').getPublicUrl(filePath);
      const fileName = `vidnote_${Date.now()}.webm`;

      if (inChannel) {
        await window.supabaseClient.from('channel_messages').insert({
          channel_id: inChannel.id,
          sender_id: currentUser.id,
          content: null,
          file_url: urlData.publicUrl,
          file_name: fileName,
          file_type: 'video/webm'
        });
      } else {
        const { data: msgData, error: msgError } = await window.supabaseClient
          .from('messages')
          .insert({
            sender_id: currentUser.id,
            receiver_id: selectedChat.id,
            content: null,
            file_url: urlData.publicUrl,
            file_name: fileName,
            file_type: 'video/webm',
            file_size: vidnoteBlob.size
          })
          .select().single();
        if (!msgError) appendMessage(msgData);
      }

      cancelVideoNoteRecording();
      loadConversations();
    } catch (err) {
      showToast('Ошибка отправки видеокружка', 'error');
    } finally {
      hideUploadIndicator();
    }
  }

  function toggleVidnote(uid) {
    const wrap = document.getElementById(uid);
    if (!wrap) return;
    const video = document.getElementById(uid + '-video');
    if (!video) return;

    const circumference = 301.6; // 2*π*48

    // Stop any currently playing vidnote
    if (_currentVidnoteUid && _currentVidnoteUid !== uid) {
      const prev = document.getElementById(_currentVidnoteUid);
      const prevVid = document.getElementById(_currentVidnoteUid + '-video');
      const prevProg = document.getElementById(_currentVidnoteUid + '-progress');
      const prevIcon = document.getElementById(_currentVidnoteUid + '-playicon');
      if (prevVid) { prevVid.pause(); prevVid.currentTime = 0; }
      if (prev) prev.classList.remove('vidnote-playing');
      if (prevProg) prevProg.style.strokeDashoffset = circumference;
      if (prevIcon) prevIcon.style.opacity = '1';
      _currentVidnoteUid = null;
    }

    const progressEl = document.getElementById(uid + '-progress');
    const durEl = document.getElementById(uid + '-dur');
    const playIcon = document.getElementById(uid + '-playicon');

    if (video.paused) {
      video.play();
      wrap.classList.add('vidnote-playing');
      if (playIcon) playIcon.style.opacity = '0';
      _currentVidnoteUid = uid;

      // Update ring on timeupdate
      const onTimeUpdate = () => {
        if (!video.duration) return;
        const pct = video.currentTime / video.duration;
        if (progressEl) progressEl.style.strokeDashoffset = circumference * (1 - pct);
        const rem = Math.max(0, Math.floor(video.duration - video.currentTime));
        if (durEl) durEl.textContent = `${Math.floor(rem/60)}:${(rem%60).toString().padStart(2,'0')}`;
      };
      video.removeEventListener('timeupdate', video._vnTimeUpdate);
      video._vnTimeUpdate = onTimeUpdate;
      video.addEventListener('timeupdate', onTimeUpdate);

      video.onended = () => {
        wrap.classList.remove('vidnote-playing');
        if (playIcon) playIcon.style.opacity = '1';
        if (progressEl) progressEl.style.strokeDashoffset = circumference;
        video.currentTime = 0;
        _currentVidnoteUid = null;
        if (durEl && video.duration) {
          const tot = Math.floor(video.duration);
          durEl.textContent = `Кружок ${Math.floor(tot/60)}:${(tot%60).toString().padStart(2,'0')}`;
        }
      };

      // Set initial duration
      if (video.duration && durEl) {
        const tot = Math.floor(video.duration);
        durEl.textContent = `Кружок ${Math.floor(tot/60)}:${(tot%60).toString().padStart(2,'0')}`;
      } else {
        video.addEventListener('loadedmetadata', () => {
          if (durEl && video.duration) {
            const tot = Math.floor(video.duration);
            durEl.textContent = `Кружок ${Math.floor(tot/60)}:${(tot%60).toString().padStart(2,'0')}`;
          }
        }, { once: true });
      }
    } else {
      video.pause();
      wrap.classList.remove('vidnote-playing');
      if (playIcon) playIcon.style.opacity = '1';
      _currentVidnoteUid = null;
    }
  }

  // ================================================================
  //  LAST SEEN / ONLINE STATUS
  // ================================================================
  async function updateLastSeen() {
    if (!currentUser) return;
    try {
      await window.supabaseClient
        .from('profiles')
        .update({ last_seen: new Date().toISOString() })
        .eq('id', currentUser.id);
    } catch {}
  }

  // Кэш токена авторизации для использования в beforeunload (когда async невозможен)
  let _cachedAccessToken = '';
  async function _refreshCachedToken() {
    try {
      const { data } = await window.supabaseClient.auth.getSession();
      if (data?.session?.access_token) _cachedAccessToken = data.session.access_token;
    } catch {}
  }

  // Ставит last_seen в прошлое (offline) при уходе со страницы
  function _setOffline() {
    if (!currentUser) return;
    const offlineTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const token = _cachedAccessToken || window.SUPABASE_ANON_KEY || '';
    const body = JSON.stringify({ last_seen: offlineTime });
    try {
      // sendBeacon не поддерживает заголовки — используем fetch с keepalive
      fetch(`${window.SUPABASE_URL || ''}/rest/v1/profiles?id=eq.${currentUser.id}`, {
        method: 'PATCH', keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          'apikey': window.SUPABASE_ANON_KEY || '',
          'Authorization': `Bearer ${token}`,
          'Prefer': 'return=minimal',
        },
        body,
      }).catch(() => {});
    } catch {}
  }

  let _presenceVisInitialized = false;
  function _initPresenceVisibility() {
    if (_presenceVisInitialized) return;
    _presenceVisInitialized = true;

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'hidden') {
        _setOffline();
      } else {
        updateLastSeen();
        // Когда пользователь вернулся — пометить непрочитанные + обновить диалоги ОДИН раз
        if (selectedChat) {
          await markMessagesAsRead(selectedChat.id);
        }
        loadConversations();
      }
    });

    window.addEventListener('beforeunload', () => {
      _setOffline();
    });

    window.addEventListener('pagehide', () => {
      _setOffline();
    });

    // Electron: уведомление от main-процесса при скрытии окна в трей
    if (window.electronAPI && window.electronAPI.onWindowHide) {
      window.electronAPI.onWindowHide(() => {
        _setOffline();
      });
    }
  }

  // Проверяет, онлайн ли пользователь по last_seen (< 2 мин назад)
  function _isUserOnline(profile) {
    if (!profile || !profile.last_seen) return false;
    return (Date.now() - new Date(profile.last_seen).getTime()) < 120000;
  }

  // HTML зелёной точки для аватара в списке диалогов
  function _onlineDotHTML(userId, online) {
    return `<span class="online-dot${online ? '' : ' online-dot--off'}" data-online-dot="${userId}"></span>`;
  }

  function formatLastSeen(lastSeen) {
    if (!lastSeen) return '';
    const now = new Date();
    const ls = new Date(lastSeen);
    const diffMs = now - ls;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMin < 2) return 'в сети';
    const timeStr = ls.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart - 86400000);
    if (ls >= todayStart) return `был(а) сегодня в ${timeStr}`;
    if (ls >= yesterdayStart) return `был(а) вчера в ${timeStr}`;
    if (diffDays < 7) return 'был(а) недавно';
    return 'был(а) давно';
  }

  // ============================================================
  // Realtime-подписка на изменения группы (аватарка, название и т.д.)
  // Позволяет всем участникам видеть обновления без перезагрузки страницы
  // ============================================================
  function subscribeToGroupUpdates() {
    if (groupsRealtimeSub) {
      try { window.supabaseClient.removeChannel(groupsRealtimeSub); } catch {}
      groupsRealtimeSub = null;
    }
    groupsRealtimeSub = window.supabaseClient
      .channel('groups-updates-global')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'groups' },
        (payload) => {
          if (!payload.new || !payload.new.id) return;
          const updatedGroup = payload.new;
          const idx = groups.findIndex(g => g.id === updatedGroup.id);
          if (idx === -1) return; // эта группа не наша — игнорируем

          // Обновляем локальный массив
          groups[idx] = { ...groups[idx], ...updatedGroup };

          // Если это текущая открытая группа — обновляем UI
          if (selectedGroup && selectedGroup.id === updatedGroup.id) {
            selectedGroup = { ...selectedGroup, ...updatedGroup };

            // Обновляем аватарку в шапке
            if (updatedGroup.avatar_url) {
              const headerContent = getEl('chat-header-content');
              if (headerContent) {
                const oldAvatarEl = headerContent.querySelector('.chat-header-user img[alt="group"], .chat-header-user .conv-group-avatar');
                if (oldAvatarEl) {
                  const newImg = document.createElement('img');
                  newImg.src = updatedGroup.avatar_url;
                  newImg.setAttribute('style', 'width:40px;height:40px;border-radius:13px;object-fit:cover;flex-shrink:0;');
                  newImg.alt = 'group';
                  oldAvatarEl.replaceWith(newImg);
                }
              }
            }

            // Обновляем инфо-панель если открыта
            const gipPanel = getEl('group-info-panel');
            if (gipPanel && gipPanel.classList.contains('open')) {
              renderGroupInfoPanel();
            }
          }

          // Перерисовываем список диалогов для всех участников
          renderConversations();
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'group_members' },
        async (payload) => {
          const groupId = payload.new?.group_id || payload.old?.group_id;
          if (!groupId) return;

          // Инвалидируем кэш участников для этой группы
          delete groupMembersCache[groupId];

          // Если открыта эта группа — обновляем только статус в шапке
          if (selectedGroup && selectedGroup.id === groupId) {
            try {
              const { data: members } = await window.supabaseClient
                .from('group_members')
                .select('user_id, role, muted')
                .eq('group_id', groupId);
              const memberIds = (members || []).map(m => m.user_id);
              const profiles = allProfiles.filter(p => memberIds.includes(p.id));
              groupMembersCache[groupId] = { members: members || [], profiles };

              const memberCount = (members || []).length;
              const statusEl = document.querySelector('.chat-header-status');
              if (statusEl) {
                if (profiles.length <= 4 && profiles.length > 0) {
                  statusEl.textContent = profiles.map(p => getDisplayName(p)).join(', ');
                } else {
                  statusEl.textContent = memberCount + ' участник' + (memberCount === 1 ? '' : memberCount < 5 ? 'а' : 'ов');
                }
              }
              // Обновляем инфо-панель если открыта
              const gipPanel = getEl('group-info-panel');
              if (gipPanel && gipPanel.classList.contains('open')) {
                renderGroupInfoPanel();
              }
            } catch {}
          }

          // Обновляем список диалогов
          renderConversations();
        })
      .subscribe();
  }

  // ============================================================
  // Realtime-подписка на изменения профилей всех пользователей
  // Мгновенно обновляет аватарки и имена без перезагрузки страницы
  // ============================================================
  function subscribeToProfiles() {
    if (profilesRealtimeSub) {
      try { window.supabaseClient.removeChannel(profilesRealtimeSub); } catch {}
      profilesRealtimeSub = null;
    }
    profilesRealtimeSub = window.supabaseClient
      .channel('profiles-updates-global')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (payload) => {
        if (!payload.new || !payload.new.id) return;
        const updated = payload.new;

        // Обновляем локальный кэш профилей
        const idx = allProfiles.findIndex(p => p.id === updated.id);
        if (idx !== -1) {
          allProfiles[idx] = { ...allProfiles[idx], ...updated };
        }

        // Обновляем профиль текущего пользователя если это он сам
        if (currentProfile && currentProfile.id === updated.id) {
          currentProfile = { ...currentProfile, ...updated };
          // Обновляем аватарку в настройках
          const avatarEl = getEl('settings-avatar-img');
          if (avatarEl) avatarEl.innerHTML = getAvatarHTML(currentProfile, 72);
        }

        // Если это собеседник в текущем открытом чате — обновляем шапку
        if (selectedChat && selectedChat.id === updated.id) {
          selectedChat = { ...selectedChat, ...updated };
          const headerAvatar = document.querySelector('.chat-header-user img.avatar-img');
          if (headerAvatar && updated.avatar_url) {
            // Crossfade при смене аватара
            headerAvatar.classList.remove('avatar-updated');
            void headerAvatar.offsetWidth;
            headerAvatar.src = updated.avatar_url;
            headerAvatar.classList.add('avatar-updated');
          } else if (updated.avatar_url || updated.username) {
            // Пересобираем шапку если аватарка была placeholder
            const headerNameEl = document.querySelector('.chat-header-name');
            const headerAvatarWrap = document.querySelector('.chat-header-user');
            if (headerAvatarWrap) {
              const oldImg = headerAvatarWrap.querySelector('.avatar-img, .avatar-placeholder');
              if (oldImg) {
                const newAvatarEl = document.createElement('div');
                newAvatarEl.innerHTML = getAvatarHTML(allProfiles[idx] || updated, 40);
                oldImg.replaceWith(newAvatarEl.firstChild);
              }
            }
          }
        }

        // Живое обновление зелёной точки онлайн-статуса в сайдбаре
        if (updated.last_seen !== undefined) {
          const dot = document.querySelector(`[data-online-dot="${updated.id}"]`);
          if (dot) {
            const nowOnline = _isUserOnline(updated);
            const wasOnline = !dot.classList.contains('online-dot--off');
            if (nowOnline && !wasOnline) {
              dot.classList.remove('online-dot--off');
            } else if (!nowOnline && wasOnline) {
              dot.classList.add('online-dot--anim-out');
              dot.addEventListener('animationend', () => {
                dot.classList.remove('online-dot--anim-out');
                dot.classList.add('online-dot--off');
              }, { once: true });
            }
          }
        }

        // Обновляем список диалогов (аватарки там тоже)
        renderConversations();
      })
      .subscribe();
  }

  function subscribeToPresence(userId) {
    if (presenceSubscription) {
      try { window.supabaseClient.removeChannel(presenceSubscription); } catch {}
      presenceSubscription = null;
    }
    presenceSubscription = window.supabaseClient
      .channel(`profile-presence-${userId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        (payload) => {
          const statusEl = document.getElementById(`chat-status-${userId}`);
          if (statusEl && payload.new && payload.new.last_seen) {
            statusEl.textContent = formatLastSeen(payload.new.last_seen);
            statusEl.className = 'chat-header-status' + (formatLastSeen(payload.new.last_seen) === 'в сети' ? ' status-online' : ' status-offline');
          }
        })
      .subscribe();
  }

  // ============================================================
  // TYPING INDICATOR
  // ============================================================
  let typingChannel = null;         // Канал Realtime для typing
  let typingTimer = null;           // Таймер сброса typing (у текущего пользователя)
  let typingHideTimer = null;       // Таймер скрытия «печатает» у собеседника
  let isTypingSent = false;         // Флаг: уже отправили событие typing

  function subscribeToTyping(partnerId) {
    if (typingChannel) {
      try { window.supabaseClient.removeChannel(typingChannel); } catch {}
      typingChannel = null;
    }
    // Канал для пары (меньший id первым — симметрично)
    const ids = [currentUser.id, partnerId].sort();
    const channelName = `typing_${ids[0]}_${ids[1]}`;
    typingChannel = window.supabaseClient.channel(channelName);
    typingChannel
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        if (payload.userId !== currentUser.id) {
          showTypingIndicator();
        }
      })
      .on('broadcast', { event: 'stop_typing' }, ({ payload }) => {
        if (payload.userId !== currentUser.id) {
          hideTypingIndicator();
        }
      })
      .subscribe();
  }

  function unsubscribeTyping() {
    if (typingChannel) {
      try { window.supabaseClient.removeChannel(typingChannel); } catch {}
      typingChannel = null;
    }
    isTypingSent = false;
    clearTimeout(typingTimer);
    clearTimeout(typingHideTimer);
  }

  function sendTypingEvent() {
    if (!typingChannel || !selectedChat) return;
    if (!isTypingSent) {
      isTypingSent = true;
      typingChannel.send({ type: 'broadcast', event: 'typing', payload: { userId: currentUser.id } });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      isTypingSent = false;
      typingChannel.send({ type: 'broadcast', event: 'stop_typing', payload: { userId: currentUser.id } });
    }, 3000);
  }

  function showTypingIndicator() {
    clearTimeout(typingHideTimer);
    // В шапке чата — заменяем статус с анимированными точками
    const statusEl = selectedChat ? document.getElementById(`chat-status-${selectedChat.id}`) : null;
    if (statusEl) {
      if (!statusEl.dataset.prevText) statusEl.dataset.prevText = statusEl.textContent;
      statusEl.innerHTML = 'печатает<span class="typing-dots"><span></span><span></span><span></span></span>';
      statusEl.className = 'chat-header-status typing-status';
    }
    // В списке диалогов — текст превью
    const convEl = document.querySelector(`.conversation-item[data-user-id="${selectedChat?.id}"] .conv-text`);
    if (convEl) {
      if (!convEl.dataset.prevText) convEl.dataset.prevText = convEl.textContent;
      convEl.textContent = 'печатает…';
      convEl.className = 'conv-text typing-text';
    }
    typingHideTimer = setTimeout(hideTypingIndicator, 4000);
  }

  function hideTypingIndicator() {
    clearTimeout(typingHideTimer);
    const statusEl = selectedChat ? document.getElementById(`chat-status-${selectedChat.id}`) : null;
    if (statusEl && statusEl.dataset.prevText !== undefined) {
      statusEl.textContent = statusEl.dataset.prevText;
      statusEl.className = statusEl.textContent === 'в сети' ? 'chat-header-status status-online' : 'chat-header-status status-offline';
      delete statusEl.dataset.prevText;
    }
    const convEl = document.querySelector(`.conversation-item[data-user-id="${selectedChat?.id}"] .conv-text`);
    if (convEl && convEl.dataset.prevText !== undefined) {
      convEl.textContent = convEl.dataset.prevText;
      convEl.className = 'conv-text';
      delete convEl.dataset.prevText;
    }
  }

  // ============================================================
  // УДАЛЕНИЕ И РЕДАКТИРОВАНИЕ СООБЩЕНИЙ
  // ============================================================
  let editingMessageId = null;  // ID редактируемого сообщения

  // Удалить для себя — физически удаляем из БД (с проверкой sender_id)
  async function deleteMessageForMe(msgId) {
    const el = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (el) el.remove();
    renderedMessageIds.delete(msgId);
    // Permanently delete from DB so it never comes back after reload/realtime
    try {
      const table = selectedGroup ? 'group_messages' : 'messages';
      await window.supabaseClient
        .from(table)
        .delete()
        .eq('id', msgId)
        .eq('sender_id', currentUser.id);
    } catch(e) { console.warn('[deleteForMe] DB error:', e); }
  }

  // Вспомогательная функция: удаляет файл из Supabase Storage по публичному URL
  async function _deleteStorageFile(fileUrl) {
    if (!fileUrl) return;
    try {
      const url = new URL(fileUrl);
      const pathParts = url.pathname.split('/chat-files/');
      if (pathParts.length > 1) {
        const filePath = decodeURIComponent(pathParts[1].split('?')[0]);
        await window.supabaseClient.storage.from('chat-files').remove([filePath]);
      }
    } catch (err) {
      console.warn('[_deleteStorageFile] не удалось удалить файл из хранилища:', err);
    }
  }

  // Удалить для всех (физически из БД + файл из хранилища)
  async function deleteMessageForAll(msgId) {
    try {
      // Сначала читаем запись, чтобы знать URL файла (если был)
      const { data: msgData } = await window.supabaseClient
        .from('messages')
        .select('file_url')
        .eq('id', msgId)
        .eq('sender_id', currentUser.id)
        .maybeSingle();

      const { error } = await window.supabaseClient
        .from('messages')
        .delete()
        .eq('id', msgId)
        .eq('sender_id', currentUser.id);
      if (!error) {
        deleteMessageForMe(msgId);
        // Удаляем прикреплённый файл из хранилища
        if (msgData?.file_url) await _deleteStorageFile(msgData.file_url);
      } else {
        showToast('Не удалось удалить', 'error');
        console.error('deleteForAll error:', error);
      }
    } catch (err) {
      showToast('Ошибка при удалении', 'error');
      console.error(err);
    }
  }

  // Редактирование — inline прямо в пузыре сообщения
  function startEditMessage(msgId, currentText) {
    finishInlineEdit();
    const wrapper = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (!wrapper) return;
    const textEl = wrapper.querySelector('.msg-text');
    if (!textEl) return;

    editingMessageId = msgId;
    textEl.contentEditable = 'true';
    textEl.dataset.originalText = currentText;
    textEl.classList.add('editing-inline');
    textEl.focus();

    // Курсор в конец
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(textEl);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    function onKeyDown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const newText = textEl.textContent.trim();
        textEl.removeEventListener('keydown', onKeyDown);
        saveInlineEdit(msgId, newText, textEl);
      } else if (e.key === 'Escape') {
        textEl.textContent = currentText;
        textEl.removeEventListener('keydown', onKeyDown);
        finishInlineEdit();
      }
    }
    textEl.addEventListener('keydown', onKeyDown);
  }

  function finishInlineEdit() {
    editingMessageId = null;
    document.querySelectorAll('.editing-inline').forEach(el => {
      el.contentEditable = 'false';
      el.classList.remove('editing-inline');
    });
  }

  function cancelEdit() { finishInlineEdit(); }

  async function saveInlineEdit(msgId, newText, textEl) {
    if (!newText) { finishInlineEdit(); return; }
    textEl.contentEditable = 'false';
    textEl.classList.remove('editing-inline');
    textEl.textContent = newText;
    editingMessageId = null;

    try {
      const { error } = await window.supabaseClient
        .from('messages')
        .update({ content: newText, updated_at: new Date().toISOString() })
        .eq('id', msgId)
        .eq('sender_id', currentUser.id);
      if (!error) {
        const wrapper = document.querySelector('[data-msg-id="' + msgId + '"]');
        if (wrapper && !wrapper.querySelector('.msg-edited')) {
          const mark = document.createElement('span');
          mark.className = 'msg-edited';
          mark.textContent = 'изменено';
          const timeEl = wrapper.querySelector('.msg-time');
          if (timeEl) timeEl.insertAdjacentElement('beforebegin', mark);
        }
      } else {
        showToast('Не удалось сохранить', 'error');
        console.error('edit error:', error);
      }
    } catch (err) {
      showToast('Ошибка при редактировании', 'error');
      console.error(err);
    }
  }

  async function saveEditMessage(newText) {
    if (editingMessageId) {
      const textEl = document.querySelector('[data-msg-id="' + editingMessageId + '"] .msg-text');
      if (textEl) await saveInlineEdit(editingMessageId, newText, textEl);
    }
  }

  // ============================================================
  // PIN (ЗАКРЕПЛЁННЫЕ СООБЩЕНИЯ)
  // ============================================================
  // Строим глобальный ключ беседы (одинаковый для обоих участников)
  function buildPinKey() {
    if (selectedGroup) return 'grp_' + selectedGroup.id;
    // Для DM: сортируем ID чтобы ключ совпадал у обоих участников
    if (selectedChat) {
      const ids = [currentUser.id, selectedChat.id].sort();
      return 'dm_' + ids[0] + '_' + ids[1];
    }
    const ch = window.Channels && window.Channels.selectedChannel;
    if (ch) return 'ch_' + ch.id;
    return null;
  }

  async function pinMessage(msgId, text) {
    const key = buildPinKey();
    if (!key) return;
    const pinData = { msgId, text: (text || '').slice(0, 120) };
    // Сохраняем в БД для видимости всем участникам
    try {
      await window.supabaseClient.from('pinned_messages').upsert({
        id: key,
        message_id: String(msgId),
        message_text: pinData.text,
        pinned_by: currentUser.id,
        pinned_at: new Date().toISOString(),
      }, { onConflict: 'id' });
    } catch {}
    // localStorage как быстрый кэш
    localStorage.setItem('pin_' + key, JSON.stringify(pinData));
    showPinBar(pinData);
    showToast('Сообщение закреплено 📌', 'success');
  }

  async function unpinMessage() {
    const key = buildPinKey();
    if (!key) return;
    try {
      await window.supabaseClient.from('pinned_messages').delete().eq('id', key);
    } catch {}
    localStorage.removeItem('pin_' + key);
    const bar = getEl('pin-bar');
    if (bar) bar.style.display = 'none';
    showToast('Сообщение откреплено', 'success');
  }

  function scrollToPinnedMessage() {
    const key = buildPinKey();
    if (!key) return;
    try {
      const pinData = JSON.parse(localStorage.getItem('pin_' + key) || 'null');
      if (!pinData) return;
      const el = document.querySelector('[data-msg-id="' + pinData.msgId + '"]');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const bubble = el.querySelector('.message-bubble, .gm-bubble');
        if (bubble) {
          // Своё сообщение = синий пузырь (#5b55e8) → используем янтарный для контраста
          // Чужое сообщение = тёмно-серый/белый пузырь → используем зелёный/бирюзовый
          const isOwn = el.classList.contains('own') || el.classList.contains('gm-own');
          const glowColor = isOwn
            ? '0 0 0 3px rgba(251,191,36,0.95), 0 0 12px rgba(251,191,36,0.5)'   // янтарь — виден на синем
            : '0 0 0 3px rgba(52,211,153,0.95), 0 0 12px rgba(52,211,153,0.5)';  // зелёный — виден на сером/белом
          const orig = bubble.style.transition;
          bubble.style.transition = 'box-shadow 0.25s';
          bubble.style.boxShadow = glowColor;
          setTimeout(() => { bubble.style.boxShadow = ''; bubble.style.transition = orig; }, 1600);
        }
      }
    } catch (_) {}
  }

  function showPinBar(pinData) {
    const bar = getEl('pin-bar');
    const textEl = getEl('pin-bar-text');
    if (!bar || !textEl) return;
    textEl.textContent = pinData.text || '(прикреплённый файл)';
    bar.style.display = 'flex';
    // Анимация выезжания сверху
    bar.classList.remove('pin-bar--animate');
    void bar.offsetWidth;
    bar.classList.add('pin-bar--animate');
  }

  async function loadAndShowPinBar() {
    const key = buildPinKey();
    const bar = getEl('pin-bar');
    if (!bar) return;
    if (!key) { bar.style.display = 'none'; return; }

    // Сначала быстрый показ из localStorage
    try {
      const cached = JSON.parse(localStorage.getItem('pin_' + key) || 'null');
      if (cached) showPinBar(cached);
      else bar.style.display = 'none';
    } catch (_) { bar.style.display = 'none'; }

    // Затем актуальные данные из БД (могли быть закреплены другим участником)
    try {
      const { data } = await window.supabaseClient
        .from('pinned_messages')
        .select('message_id, message_text')
        .eq('id', key)
        .maybeSingle();
      if (data) {
        const pinData = { msgId: data.message_id, text: data.message_text };
        localStorage.setItem('pin_' + key, JSON.stringify(pinData));
        showPinBar(pinData);
      } else {
        // В БД нет — снимаем
        localStorage.removeItem('pin_' + key);
        bar.style.display = 'none';
      }
    } catch {}
  }

  // Подписка на изменения закреплённых сообщений (Realtime)
  function subscribeToPinnedMessages() {
    window.supabaseClient
      .channel('pinned-messages-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pinned_messages' }, (payload) => {
        const currentKey = buildPinKey();
        const changedKey = (payload.new && payload.new.id) || (payload.old && payload.old.id);
        if (!currentKey || changedKey !== currentKey) return;
        if (payload.eventType === 'DELETE') {
          localStorage.removeItem('pin_' + currentKey);
          const bar = getEl('pin-bar');
          if (bar) bar.style.display = 'none';
        } else if (payload.new) {
          const pinData = { msgId: payload.new.message_id, text: payload.new.message_text };
          localStorage.setItem('pin_' + currentKey, JSON.stringify(pinData));
          showPinBar(pinData);
        }
      })
      .subscribe();
  }

  // ============================================================
  // @MENTIONS — HIGHLIGHT IN GROUP MESSAGES
  // ============================================================
  function highlightMentions(escapedHtml) {
    if (!escapedHtml) return escapedHtml;
    return escapedHtml.replace(/@(\w+)/g, (match, username) => {
      if (currentUser && username.toLowerCase() === (currentUser.username || '').toLowerCase()) {
        return `<span class="mention mention-me">@${username}</span>`;
      }
      return `<span class="mention">@${username}</span>`;
    });
  }

  // ============================================================
  // @MENTIONS — INPUT AUTOCOMPLETE (GROUP ONLY)
  // ============================================================
  let mentionListenerAdded = false;

  function initGroupMentionAutocomplete() {
    if (mentionListenerAdded) return;
    mentionListenerAdded = true;

    const input = getEl('message-input');
    const popup = getEl('mention-popup');
    if (!input || !popup) return;

    input.addEventListener('input', () => {
      if (!selectedGroup) { popup.style.display = 'none'; return; }
      const val = input.value;
      const cursor = input.selectionStart;
      const before = val.slice(0, cursor);
      const atIdx = before.lastIndexOf('@');
      if (atIdx === -1) { popup.style.display = 'none'; return; }
      // Only trigger if @ is at start or after a space/newline
      if (atIdx > 0 && !/[\s\n]/.test(before[atIdx - 1])) { popup.style.display = 'none'; return; }
      const query = before.slice(atIdx + 1).toLowerCase();
      const cache = groupMembersCache[selectedGroup ? selectedGroup.id : ''] || { profiles: [] };
      const matches = (cache.profiles || [])
        .filter(p => p.id !== currentUser.id)
        .filter(p =>
          (getContactDisplayName(p) || '').toLowerCase().includes(query) ||
          (p.username || '').toLowerCase().includes(query)
        )
        .slice(0, 6);
      if (!matches.length) { popup.style.display = 'none'; return; }
      popup.innerHTML = matches.map(p => `
        <div class="mention-item"
          data-uname="${escapeHTML(p.username)}"
          data-at="${atIdx}"
          data-cursor="${cursor}">
          ${getContactAvatarHTML(p, 24)}
          <span class="mention-item-name">${escapeHTML(getContactDisplayName(p))}</span>
          <span class="mention-item-uname">@${escapeHTML(p.username)}</span>
        </div>`).join('');
      popup.style.display = 'block';
      popup.querySelectorAll('.mention-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const uname = item.dataset.uname;
          const ai = parseInt(item.dataset.at);
          const cp = parseInt(item.dataset.cursor);
          const v = input.value;
          const mention = '@' + uname + ' ';
          input.value = v.slice(0, ai) + mention + v.slice(cp);
          const newPos = ai + mention.length;
          input.setSelectionRange(newPos, newPos);
          input.focus();
          input.dispatchEvent(new Event('input', { bubbles: true }));
          popup.style.display = 'none';
        });
      });
    });

    input.addEventListener('blur', () => { setTimeout(() => { popup.style.display = 'none'; }, 150); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') popup.style.display = 'none';
    });
  }

  // Показать контекстное меню на сообщении
  function showMessageContextMenu(e, msgId, isMine, textContent, fileUrl, fileName) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.msg-context-menu').forEach(m => m.remove());

    // Определяем, закреплено ли уже это сообщение
    const pinKey = buildPinKey();
    let isPinned = false;
    if (pinKey) {
      try {
        const pinData = JSON.parse(localStorage.getItem(pinKey) || 'null');
        isPinned = !!(pinData && pinData.msgId === msgId);
      } catch (_) {}
    }
    const pinBtnHTML = isPinned
      ? `<button class="msg-ctx-item" data-action="unpin">📌 Открепить</button>`
      : `<button class="msg-ctx-item" data-action="pin">📌 Закрепить</button>`;

    const menu = document.createElement('div');
    menu.className = 'msg-context-menu';
    const downloadBtnHTML = fileUrl
      ? `<button class="msg-ctx-item" data-action="download">⬇️ Скачать файл</button>`
      : '';
    // Проверяем, есть ли выделенный текст в сообщении
    const selection = window.getSelection();
    const hasSelection = selection && selection.toString().trim().length > 0;
    const quoteBtn = hasSelection
      ? `<button class="msg-ctx-item" data-action="quote-reply">❝ Ответить с цитатой</button>`
      : '';

    if (isMine) {
      menu.innerHTML = `
        <button class="msg-ctx-item" data-action="reply">↩ Ответить</button>
        ${quoteBtn}
        ${pinBtnHTML}
        <button class="msg-ctx-item" data-action="select">✓ Выделить</button>
        <button class="msg-ctx-item" data-action="edit">✏️ Редактировать</button>
        <button class="msg-ctx-item" data-action="forward">↪️ Переслать</button>
        <button class="msg-ctx-item" data-action="who-read">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Кто прочитал
        </button>
        ${downloadBtnHTML}
        <div class="msg-ctx-divider"></div>
        <button class="msg-ctx-item" data-action="delete-me">🙈 Удалить у себя</button>
        <button class="msg-ctx-item msg-ctx-item--danger" data-action="delete-all">🗑️ Удалить для всех</button>
      `;
    } else {
      menu.innerHTML = `
        <button class="msg-ctx-item" data-action="reply">↩ Ответить</button>
        ${quoteBtn}
        ${pinBtnHTML}
        <button class="msg-ctx-item" data-action="select">✓ Выделить</button>
        <button class="msg-ctx-item" data-action="forward">↪️ Переслать</button>
        ${downloadBtnHTML}
        <button class="msg-ctx-item" data-action="delete-me">🙈 Удалить у себя</button>
      `;
    }

    // Сохраняем выделенный текст до закрытия меню
    const selectedQuoteText = hasSelection ? selection.toString().trim() : '';

    document.body.appendChild(menu);

    menu.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        menu.remove();
        if (action === 'reply') {
          // Ответить на сообщение
          const msgWrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
          const senderProfile = isMine ? { username: 'Вы', avatar_url: currentUser.avatar_url }
            : (selectedChat || allProfiles.find(p => p.id !== currentUser.id && msgWrapper));
          const senderName = isMine ? 'Вы' : (senderProfile ? getDisplayName(senderProfile) : '');
          const senderAvatar = isMine ? currentUser.avatar_url : (senderProfile ? senderProfile.avatar_url : null);
          startReply(msgId, senderName, senderAvatar, textContent);
        }
        else if (action === 'quote-reply') {
          const senderProfile = isMine ? null : selectedChat;
          const senderName = isMine ? 'Вы' : (senderProfile ? getDisplayName(senderProfile) : '');
          const senderAvatar = isMine ? currentUser.avatar_url : (senderProfile ? senderProfile.avatar_url : null);
          startReplyWithQuote(msgId, senderName, senderAvatar, selectedQuoteText);
        }
        else if (action === 'pin') pinMessage(msgId, textContent);
        else if (action === 'unpin') unpinMessage();
        else if (action === 'select') enterSelectionMode(msgId);
        else if (action === 'edit') startEditMessage(msgId, textContent);
        else if (action === 'forward') openForwardModal(msgId, textContent);
        else if (action === 'who-read') showWhoReadModal(msgId);
        else if (action === 'delete-me') deleteMessageForMe(msgId);
        else if (action === 'delete-all') deleteMessageForAll(msgId);
        else if (action === 'download') {
          (async () => {
            try {
              const res = await fetch(fileUrl);
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = fileName || 'file';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 3000);
            } catch {
              window.open(fileUrl, '_blank');
            }
          })();
        }
      });
    });

    let x = e.clientX, y = e.clientY;
    menu.style.left = '0px'; menu.style.top = '-9999px';
    requestAnimationFrame(() => {
      const mh = menu.offsetHeight, mw = menu.offsetWidth;
      const vw = window.innerWidth, vh = window.innerHeight;
      if (x + mw > vw) x = vw - mw - 8;
      if (x < 8) x = 8;
      if (y + mh > vh) y = y - mh - 8;
      if (y < 8) y = 8;
      if (_isMobile && mw > vw - 24) {
        x = 12;
        menu.style.width = (vw - 24) + 'px';
      }
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
    });

    const close = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); document.removeEventListener('touchstart', close); }
    };
    setTimeout(() => {
      document.addEventListener('click', close);
      document.addEventListener('touchstart', close, { passive: true });
    }, 10);
  }

  // ============================================================
  // КТО ПРОЧИТАЛ СООБЩЕНИЕ
  // ============================================================
  async function showWhoReadModal(msgId) {
    // Получаем данные сообщения
    let msg;
    try {
      const { data, error } = await window.supabaseClient
        .from('messages')
        .select('id, sender_id, receiver_id, is_read, created_at')
        .eq('id', msgId)
        .single();
      if (error || !data) { showToast('Сообщение не найдено', 'error'); return; }
      msg = data;
    } catch { showToast('Ошибка загрузки', 'error'); return; }

    // Только для DM: один получатель
    const recipientId = msg.receiver_id;
    const recipient = allProfiles.find(p => p.id === recipientId) || null;
    const recipientName = recipient
      ? escapeHTML(recipient.display_name || recipient.username || 'Пользователь')
      : 'Пользователь';
    const recipientAvatar = recipient && recipient.avatar_url
      ? `<img src="${escapeHTML(recipient.avatar_url)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
      : `<div style="width:36px;height:36px;border-radius:50%;background:var(--accent-color);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;flex-shrink:0;">${recipientName.charAt(0)}</div>`;

    const isRead = !!msg.is_read;

    // Удаляем старое окно
    document.getElementById('who-read-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'who-read-modal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'display:flex;z-index:9999;';

    // Строим список
    const readSection = isRead ? `
      <div class="wr-section-label">
        ${msgTickHTML('read')}
        <span>Прочитали</span>
      </div>
      <div class="wr-user-row">
        ${recipientAvatar}
        <span class="wr-user-name">${recipientName}</span>
      </div>` : '';

    const deliveredSection = !isRead ? `
      <div class="wr-section-label">
        ${msgTickHTML('delivered')}
        <span>Доставлено</span>
      </div>
      <div class="wr-user-row">
        ${recipientAvatar}
        <span class="wr-user-name">${recipientName}</span>
      </div>` : '';

    modal.innerHTML = `
      <div class="modal-box" style="max-width:320px;padding:0;overflow:hidden;">
        <div class="modal-header">
          <span>Статус сообщения</span>
          <button class="modal-close-btn" onclick="document.getElementById('who-read-modal').remove()">✕</button>
        </div>
        <div class="modal-body" style="padding:14px 16px;">
          ${readSection}
          ${deliveredSection}
          ${!isRead && !readSection ? '<div style="text-align:center;padding:10px;color:var(--text-muted);font-size:13px;">Ещё никто не прочитал</div>' : ''}
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  // ============================================================
  // ПЕРЕСЫЛКА СООБЩЕНИЙ
  // ============================================================
  let forwardMsgId = null;
  let forwardMsgText = '';
  let forwardMsgQueue = []; // Очередь сообщений при пересылке нескольких

  function openForwardModal(msgId, text) {
    forwardMsgId = msgId;
    forwardMsgText = text;
    const modal = getEl('forward-modal');
    const searchInput = getEl('forward-search');
    if (modal) modal.style.display = 'flex';
    // Обновляем подзаголовок если несколько сообщений
    const subtitle = modal && modal.querySelector('.forward-modal-subtitle');
    if (subtitle) {
      subtitle.textContent = forwardMsgQueue.length > 1
        ? `${forwardMsgQueue.length} сообщений — каждое отдельно`
        : '';
    }
    if (searchInput) { searchInput.value = ''; }
    renderForwardList('');
    if (searchInput) searchInput.focus();
  }

  function closeForwardModal() {
    forwardMsgId = null;
    forwardMsgText = '';
    forwardMsgQueue = [];
    const modal = getEl('forward-modal');
    if (modal) modal.style.display = 'none';
  }

  function renderForwardList(query) {
    const listEl = getEl('forward-list');
    if (!listEl) return;
    const q = query.toLowerCase().trim();

    // Личные диалоги — исключаем ботов и заблокированных пользователей
    const privateItems = conversationsList
      .filter(({ profile }) => {
        if (isBot(profile)) return false;               // нельзя слать ботам
        if (blockedUsers.has(profile.id)) return false;  // нельзя слать заблокированным
        if (!q) return true;
        return getDisplayName(profile).toLowerCase().includes(q) || profile.username.toLowerCase().includes(q);
      })
      .map(({ profile }) => ({
        id: profile.id,
        name: getDisplayName(profile),
        sub: '@' + profile.username,
        isGroup: false,
        profile
      }));

    // Мои каналы (где я администратор) — для пересылки
    const adminChannels = (window.Channels ? window.Channels.channels : [])
      .filter(ch => ch.my_role === 'admin' && (!q || ch.name.toLowerCase().includes(q)))
      .map(ch => ({
        id: ch.id,
        name: ch.name,
        sub: 'Канал',
        isChannel: true,
        channel: ch
      }));

    const all = [...adminChannels, ...privateItems];

    if (all.length === 0) {
      listEl.innerHTML = '<div class="contacts-empty">Ничего не найдено</div>';
      return;
    }

    listEl.innerHTML = '';
    all.forEach(item => {
      const div = document.createElement('div');
      div.className = 'forward-item';
      // Аватар: канал — иконка📢; пользователь — аватар
      const avatarHTML = item.isChannel
        ? `<div style="width:38px;height:38px;border-radius:10px;background:var(--accent-color);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">📢</div>`
        : getAvatarHTML(item.profile, 38);
      div.innerHTML = `
        <div class="forward-item-avatar"></div>
        <div class="forward-item-info">
          <div class="forward-item-name">${escapeHTML(item.name)}</div>
          <div class="forward-item-sub">${escapeHTML(item.sub)}</div>
        </div>
        <button class="forward-send-btn">Переслать</button>
      `;
      div.querySelector('.forward-item-avatar').innerHTML = avatarHTML;
      div.querySelector('.forward-send-btn').addEventListener('click', async () => {
        // Сохраняем данные ДО закрытия (closeForwardModal очищает переменные)
        const savedText = forwardMsgText;
        const savedQueue = [...forwardMsgQueue];
        const savedMsgId = forwardMsgId;
        const savedGroup = selectedGroup;
        const savedChat = selectedChat;
        closeForwardModal();
        if (item.isChannel) {
          // Пересылаем в канал
          const text = savedQueue.length > 0
            ? savedQueue.map(q => q.text).filter(Boolean).join('\n\n')
            : (savedText || '');
          if (window.Channels && window.Channels._forwardToChannel) {
            // Определяем источник пересылки
            let sourceName, sourceType;
            if (savedGroup) {
              sourceName = savedGroup.name;
              sourceType = 'group';
            } else if (savedChat) {
              sourceName = getDisplayName(savedChat);
              sourceType = 'user';
            } else {
              sourceName = currentUser ? (currentUser.display_name || currentUser.username || 'Пользователь') : 'Пользователь';
              sourceType = 'user';
            }
            window.Channels._forwardToChannel(item.id, text, encodeURIComponent(sourceName), sourceType);
          }
        } else {
          if (savedQueue.length > 0) {
            for (const qItem of savedQueue) {
              await sendForwardedMessage(item, qItem.msgId, qItem.text, qItem.senderName, qItem.senderId, true);
            }
            // Открываем чат/группу один раз после всех сообщений
            if (item.isGroup && item.group) openGroupChat(item.group);
            else if (!item.isGroup) await openChatWithUser(item.id);
            showToast(item.isGroup ? `Переслано в «${item.name}»` : `Переслано пользователю ${item.name}`, 'success');
          } else {
            sendForwardedMessage(item, savedMsgId, savedText);
          }
        }
      });
      listEl.appendChild(div);
    });
  }

  // ---- Парсинг пересланных сообщений ----
  // Поддерживает оба формата: новый (с uid) и старый (только имя)
  function parseForwardedMessage(content) {
    if (!content) return null;
    // Новый формат: ↪️__FWD__{"n":"Name","id":"uid"}\ntext
    const newFmt = content.match(/^↪️__FWD__(\{.*?\})\n([\s\S]*)$/);
    if (newFmt) {
      try {
        const meta = JSON.parse(newFmt[1]);
        return { senderName: meta.n || '?', senderId: meta.id || null, text: newFmt[2] };
      } catch {}
    }
    // Старый формат: ↪️ Переслано от Name:\ntext
    const oldFmt = content.match(/^↪️ Переслано от (.+?):\n([\s\S]*)$/);
    if (oldFmt) {
      return { senderName: oldFmt[1], senderId: null, text: oldFmt[2] };
    }
    // Формат пересылки из канала: ↪ Переслано из канала «Name»\ntext
    const chFmt = content.match(/^↪ Переслано из канала «(.+?)»\n([\s\S]*)$/);
    if (chFmt) {
      return { senderName: chFmt[1], senderId: null, text: chFmt[2], isChannel: true };
    }
    return null;
  }

  // overrideSenderName/overrideSenderId — для пересылки из очереди (уже определены заранее)
  async function sendForwardedMessage(target, originalMsgId, originalText, overrideSenderName, overrideSenderId, skipOpen) {
    if (!originalText && !originalMsgId) return;
    closeForwardModal();

    let originalSenderName, originalSenderId;
    if (overrideSenderName !== undefined) {
      // Данные отправителя переданы явно (пересылка из очереди)
      originalSenderName = overrideSenderName;
      originalSenderId = overrideSenderId;
    } else {
      // Определяем отправителя оригинала из DOM
      const wrapper = document.querySelector(`[data-msg-id="${originalMsgId}"]`);
      const mySenderName = currentProfile ? getDisplayName(currentProfile) : 'Пользователь';
      originalSenderName = mySenderName;
      originalSenderId = currentUser?.id || null;
      if (selectedChat && wrapper && !wrapper.classList.contains('own')) {
        originalSenderName = getDisplayName(selectedChat);
        originalSenderId = selectedChat.id;
      } else if (selectedGroup && wrapper && !wrapper.classList.contains('gm-own')) {
        // Групповое сообщение чужое — берём из data-sender если есть
        const senderId = wrapper.dataset.senderId;
        const senderProfile = senderId ? allProfiles.find(p => p.id === senderId) : null;
        if (senderProfile) {
          originalSenderName = getContactDisplayName(senderProfile);
          originalSenderId = senderProfile.id;
        }
      }
    }

    // Новый формат: содержит имя и uid для отображения аватара
    const forwardedText = `↪️__FWD__${JSON.stringify({n: originalSenderName, id: originalSenderId})}\n${originalText}`;

    try {
      if (target.isGroup) {
        // Пересылаем в группу
        await window.supabaseClient.from('group_messages').insert({
          group_id: target.id,
          sender_id: currentUser.id,
          content: forwardedText
        });
        if (!skipOpen) {
          showToast(`Переслано в «${target.name}»`, 'success');
          if (target.group) openGroupChat(target.group);
        }
      } else {
        // Пересылаем в личный чат
        await window.supabaseClient.from('messages').insert({
          sender_id: currentUser.id,
          receiver_id: target.id,
          content: forwardedText
        });
        if (!skipOpen) {
          showToast(`Переслано пользователю ${target.name}`, 'success');
          await openChatWithUser(target.id);
        }
      }
    } catch (err) {
      showToast('Ошибка при пересылке', 'error');
      console.error(err);
    }
  }


  async function loadLastSeen(profile) {
    if (!profile) return '';
    try {
      const { data } = await window.supabaseClient
        .from('profiles')
        .select('last_seen')
        .eq('id', profile.id)
        .single();
      return data && data.last_seen ? formatLastSeen(data.last_seen) : `@${profile.username}`;
    } catch { return `@${profile.username}`; }
  }

  // ---- Антифлуд: проверка и блокировка ----
  function checkFlood() {
    const now = Date.now();
    // Убираем метки старше окна
    floodTimestamps = floodTimestamps.filter(t => now - t < FLOOD_WINDOW);

    if (isFloodBlocked) return false;

    if (floodTimestamps.length >= FLOOD_LIMIT) {
      // Превышен лимит — считаем сколько ждать
      const oldest = floodTimestamps[0];
      const waitMs = FLOOD_WINDOW - (now - oldest);
      activateFloodBlock(waitMs);
      return false;
    }

    // Регистрируем отправку
    floodTimestamps.push(now);
    return true;
  }

  function activateFloodBlock(waitMs) {
    isFloodBlocked = true;
    const sendBtn = getEl('send-btn');
    const input = getEl('message-input');

    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.dataset.normalHtml = sendBtn.innerHTML;
      // Анимация вращения иконки при антифлуде
      sendBtn.innerHTML = `<svg class="antiflood-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`;
      sendBtn.title = `Антифлуд: подождите ${Math.ceil(waitMs/1000)}с`;
      sendBtn.classList.add('flood-blocked');
    }
    if (input) input.disabled = true;

    showToast(`Антифлуд: подождите ${Math.ceil(waitMs/1000)} сек`, 'error');

    if (floodCooldownTimer) clearTimeout(floodCooldownTimer);
    floodCooldownTimer = setTimeout(() => {
      isFloodBlocked = false;
      floodTimestamps = [];
      const btn = getEl('send-btn');
      const inp = getEl('message-input');
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('flood-blocked');
        if (btn.dataset.normalHtml) { btn.innerHTML = btn.dataset.normalHtml; delete btn.dataset.normalHtml; }
        btn.title = 'Отправить';
      }
      if (inp) { inp.disabled = false; inp.focus(); }
    }, waitMs);
  }

  // ---- Сжатие изображений перед загрузкой ----
  async function compressImageFile(file, maxDim = 1920, quality = 0.85) {
    if (!file.type.match(/^image\/(jpeg|jpg|png|webp)$/i)) return file;
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width <= maxDim && height <= maxDim) { resolve(file); return; }
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        canvas.toBlob((blob) => {
          if (!blob || blob.size >= file.size) { resolve(file); return; }
          const name = file.name.replace(/\.[^.]+$/, '') + (outType === 'image/png' ? '.png' : '.jpg');
          resolve(new File([blob], name, { type: outType }));
        }, outType, quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  async function sendMessage() {
    // Если открыт канал — делегируем в channels.js (только admin может)
    if (window.Channels && window.Channels.selectedChannel) { await window.Channels.sendChannelMessage(); return; }
    // Если открыт групповой чат — делегируем
    if (selectedGroup) { await sendGroupMessage(); return; }

    // Редактирование теперь inline — Enter обрабатывается в startEditMessage
    // Если вдруг editingMessageId установлен — просто отменяем и продолжаем обычную отправку
    if (editingMessageId) { finishInlineEdit(); }

    const input = getEl('message-input');
    const sendBtn = getEl('send-btn');
    if (!input || !selectedChat) return;

    const text = input.value.trim();
    // Поддержка нескольких файлов
    const filesToSend = selectedFiles.length > 0 ? [...selectedFiles] : (selectedFile ? [selectedFile] : []);
    const file = filesToSend[0] || null;

    if (!text && filesToSend.length === 0) return;

    // Анимация кнопки отправки
    if (sendBtn) {
      sendBtn.classList.remove('sending-anim');
      void sendBtn.offsetWidth;
      sendBtn.classList.add('sending-anim');
      sendBtn.addEventListener('animationend', () => sendBtn.classList.remove('sending-anim'), { once: true });
    }

    // Антифлуд-проверка
    if (!checkFlood()) return;

    // Проверяем: нас заблокировал получатель? (проверяем в Supabase)
    try {
      const { data: blockRecord } = await window.supabaseClient
        .from('user_blocks')
        .select('id')
        .eq('blocker_id', selectedChat.id)
        .eq('blocked_id', currentUser.id)
        .maybeSingle();
      if (blockRecord) {
        showBlockedModal();
        return;
      }
    } catch {
      // Таблица user_blocks не существует — fallback на localStorage
      const blockedByKey = `iflash_blockedby_${currentUser?.id}`;
      try {
        const raw = localStorage.getItem(blockedByKey);
        const arr = raw ? JSON.parse(raw) : [];
        if (arr.includes(selectedChat.id)) {
          showBlockedModal();
          return;
        }
      } catch {}
    }

    // Проверяем настройки приватности получателя
    const privacyError = await checkPrivacyForMessage(selectedChat.id);
    if (privacyError) {
      showPrivacyBlockModal(privacyError);
      return;
    }

    // ---- «Цифровая вежливость»: очередь «отправить когда в сети» ----
    if (sendWhenOnlineMode) {
      const partnerId = selectedChat.id;
      // Очищаем ввод
      clearDraftForCurrentChat();
      const qText = input.value.trim();
      input.value = '';
      input.style.height = 'auto';
      const qFiles = [...filesToSend];
      clearSelectedFile();
      updateSendBtnVisibility();

      // Загружаем файлы в storage (URL нужен сразу для отображения)
      if (qFiles.length > 0) {
        showUploadIndicator();
        for (let f of qFiles) {
          f = await compressImageFile(f);
          if (f.size > MAX_FILE_SIZE) { showToast(`${f.name}: файл слишком большой`, 'error'); continue; }
          const ext = f.name.split('.').pop();
          const filePath = `${currentUser.id}/dm_${partnerId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
          const { error: ue } = await window.supabaseClient.storage.from('chat-files').upload(filePath, f, { cacheControl: '3600', upsert: false });
          if (ue) { showToast('Ошибка загрузки файла: ' + ue.message, 'error'); continue; }
          const { data: ud } = window.supabaseClient.storage.from('chat-files').getPublicUrl(filePath);
          const qm = { local_id: 'swo-' + Date.now() + Math.random(), content: null, file_url: ud.publicUrl, file_name: f.name, file_type: f.type, file_size: f.size, partner_id: partnerId };
          pendingOnlineMessages.push(qm);
          _renderPendingOnlineMessage(qm);
        }
        hideUploadIndicator();
      }
      if (qText) {
        const qm = { local_id: 'swo-' + Date.now() + Math.random(), content: qText, file_url: null, file_name: null, file_type: null, file_size: null, partner_id: partnerId };
        pendingOnlineMessages.push(qm);
        _renderPendingOnlineMessage(qm);
      }

      // Подписываемся на присутствие получателя
      _subscribeSendWhenOnlinePresence(partnerId);

      // Если получатель уже в сети — отправляем сразу
      try {
        const { data: pData } = await window.supabaseClient.from('profiles').select('last_seen').eq('id', partnerId).single();
        if (pData && formatLastSeen(pData.last_seen) === 'в сети') {
          await _flushSendWhenOnlineQueue(partnerId);
        }
      } catch {}
      return;
    }

    sendBtn.disabled = true;
    input.disabled = true;

    try {
      // Очищаем поле ввода сразу (до ответа сервера)
      clearDraftForCurrentChat();
      const sentText = input.value;
      input.value = '';
      input.style.height = 'auto';
      clearSelectedFile();
      updateSendBtnVisibility();

      // Получаем данные ответа ДО отправки (чтобы не потерять при file upload return)
      const fileReplyData = _getReplyData();
      cancelReply();

      // Отправляем файлы — текст-подпись прикрепляется к последнему файлу
      if (filesToSend.length > 0) {
        showUploadIndicator();
        const successUploads = [];
        for (let f of filesToSend) {
          if (_uploadCancelled) break;
          f = await compressImageFile(f);
          if (f.size > MAX_FILE_SIZE) {
            showToast(`${f.name}: файл слишком большой`, 'error');
            continue;
          }
          const fileExt = f.name.split('.').pop();
          const convKey = [currentUser.id, selectedChat.id].sort().join('_');
          const filePath = `${currentUser.id}/dm_${selectedChat.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${fileExt}`;
          const { error: uploadError } = await window.supabaseClient.storage
            .from('chat-files').upload(filePath, f, { cacheControl: '3600', upsert: false });
          if (_uploadCancelled) break;
          if (uploadError) { showToast('Ошибка загрузки файла: ' + uploadError.message, 'error'); continue; }
          const { data: urlData } = window.supabaseClient.storage.from('chat-files').getPublicUrl(filePath);
          successUploads.push({ urlData, f });
        }
        hideUploadIndicator();
        if (_uploadCancelled) { _uploadCancelled = false; return; }
        for (let i = 0; i < successUploads.length; i++) {
          const { urlData, f } = successUploads[i];
          const isLast = i === successUploads.length - 1;
          const fileInsert = {
            sender_id: currentUser.id, receiver_id: selectedChat.id,
            content: isLast && sentText.trim() ? sentText : null,
            file_url: urlData.publicUrl, file_name: f.name, file_type: f.type, file_size: f.size,
          };
          // Прикрепляем ответ только к первому файлу
          if (i === 0 && fileReplyData) {
            fileInsert.reply_to = fileReplyData.reply_to;
            fileInsert.reply_text = fileReplyData.reply_text;
            fileInsert.quote_text = fileReplyData.quote_text;
          }
          const { data: fmsg } = await window.supabaseClient.from('messages').insert(fileInsert).select().single();
          if (fmsg) await appendMessage(fmsg);
        }
        return; // ← выходим, основная вставка ниже не нужна
      }

      let fileUrl = null;
      let fileName = null;
      let fileType = null;
      let fileSize = null;

      // Оптимистичное сообщение с одной серой галочкой
      const pendingId = 'pending-' + Date.now();
      const pendingMsg = {
        id: pendingId,
        sender_id: currentUser.id,
        receiver_id: selectedChat.id,
        content: text || null,
        file_url: fileUrl,
        file_name: fileName,
        file_type: fileType,
        file_size: fileSize,
        created_at: new Date().toISOString(),
        is_read: false,
        _pending: true
      };
      const pendingEl = buildMessageElement(pendingMsg, true);
      if (pendingEl) {
        // Заменяем 2 серые галочки на 1 серую (отправляется)
        const tickEl = pendingEl.querySelector('.msg-read-status');
        if (tickEl) {
          const tmp = document.createElement('div');
          tmp.innerHTML = msgTickHTML('sending');
          tickEl.replaceWith(tmp.firstElementChild);
        }
        const container = getEl('messages-container');
        if (container) {
          const noMsg = container.querySelector('.no-messages');
          if (noMsg) noMsg.remove();
          container.appendChild(pendingEl);
          container.scrollTop = container.scrollHeight;
        }
      }

      // ── E2EE: шифруем текст перед отправкой ─────────────────────
      // В Supabase хранится: "__E2EE__<base64(iv+ciphertext)>"
      // Если ключ не найден — отправляем plaintext (E2EE опционально).
      let encryptedText = text || null;
      if (encryptedText && window.Encryption) {
        try {
          encryptedText = await window.Encryption.encryptFor(encryptedText, selectedChat.id);
        } catch (e) {
          console.warn('[E2EE]', e.message, '— отправляем без шифрования');
          // encryptedText остаётся plaintext
        }
      }

      // Используем данные ответа, полученные ранее (fileReplyData)
      const replyData = fileReplyData;

      // Отправляем сообщение в БД
      const insertPayload = {
        sender_id: currentUser.id,
        receiver_id: selectedChat.id,
        content: encryptedText,
        file_url: fileUrl,
        file_name: fileName,
        file_type: fileType,
        file_size: fileSize
      };
      if (replyData) {
        insertPayload.reply_to = replyData.reply_to;
        insertPayload.reply_text = replyData.reply_text;
        insertPayload.quote_text = replyData.quote_text;
      }
      const { data: msgData, error: msgError } = await window.supabaseClient
        .from('messages')
        .insert(insertPayload)
        .select()
        .single();

      // Убираем оптимистичный элемент
      document.querySelector(`[data-msg-id="${pendingId}"]`)?.remove();

      if (msgError) {
        showToast('Ошибка отправки: ' + msgError.message, 'error');
        console.error('Ошибка отправки сообщения:', msgError);
        return;
      }

      // Добавляем реальное сообщение в UI (с 2 серыми галочками)
      appendMessage(msgData);

      // Обновляем список диалогов
      loadConversations();

    } catch (err) {
      showToast('Непредвиденная ошибка', 'error');
      console.error('Ошибка:', err);
    } finally {
      hideUploadIndicator();
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  // ============================================================
  // ---- Поиск по сообщениям в чате ----
  // ============================================================

  // Открываем/закрываем строку поиска
  function toggleMsgSearch() {
    msgSearchActive = !msgSearchActive;
    const bar = getEl('msg-search-bar');
    const input = getEl('msg-search-input');
    if (!bar) return;
    if (msgSearchActive) {
      bar.style.display = 'flex';
      setTimeout(() => { if (input) input.focus(); }, 50);
    } else {
      bar.style.display = 'none';
      if (input) input.value = '';
      msgSearchQuery = '';
      clearMsgSearchHighlights();
    }
  }

  // Сбрасываем подсветку — восстанавливаем из data-original-text
  function clearMsgSearchHighlights() {
    document.querySelectorAll('.message-wrapper').forEach(el => {
      el.classList.remove('msg-search-hidden', 'msg-search-match');
    });
    // Восстанавливаем оригинальный текст из data-атрибута
    document.querySelectorAll('[data-original-text]').forEach(el => {
      el.textContent = el.dataset.originalText;
      delete el.dataset.originalText;
    });
    const noResult = getEl('msg-search-no-result');
    if (noResult) noResult.remove();
  }

  // Подсветка найденного текста — работает с сохранённым оригиналом
  function highlightTextNode(el, query) {
    if (!el || !query) return;
    // Сохраняем оригинальный чистый текст если ещё не сохранён
    if (!el.dataset.originalText) {
      el.dataset.originalText = el.textContent;
    }
    const original = el.dataset.originalText;

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');

    if (!regex.test(original)) return;
    regex.lastIndex = 0;

    // Строим новый innerHTML с <mark> через безопасный метод
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = regex.exec(original)) !== null) {
      if (m.index > last) {
        frag.appendChild(document.createTextNode(original.slice(last, m.index)));
      }
      const mark = document.createElement('mark');
      mark.className = 'msg-hl';
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = regex.lastIndex;
    }
    if (last < original.length) {
      frag.appendChild(document.createTextNode(original.slice(last)));
    }

    // Очищаем и вставляем
    el.textContent = '';
    el.appendChild(frag);
  }

  // Выполняем поиск по сообщениям
  function performMsgSearch(query) {
    clearMsgSearchHighlights();
    if (!query || query.length < 2) return;

    const q = query.toLowerCase();
    const allWrappers = document.querySelectorAll('.message-wrapper');
    let matchCount = 0;
    let firstMatch = null;

    allWrappers.forEach(wrapper => {
      const textEl = wrapper.querySelector('.msg-text');
      const fileEl = wrapper.querySelector('.msg-file-name');

      const textContent = (textEl?.textContent || '').toLowerCase();
      const fileContent = (fileEl?.textContent || '').toLowerCase();

      const matches = textContent.includes(q) || fileContent.includes(q);

      if (matches) {
        wrapper.classList.add('msg-search-match');
        if (textEl) highlightTextNode(textEl, query);
        if (fileEl) highlightTextNode(fileEl, query);
        if (!firstMatch) firstMatch = wrapper;
        matchCount++;
      } else {
        wrapper.classList.add('msg-search-hidden');
      }
    });

    // Скроллим к первому результату
    if (firstMatch) {
      firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Показываем "ничего не найдено"
    const container = getEl('messages-container');
    if (matchCount === 0 && container) {
      const noRes = document.createElement('div');
      noRes.id = 'msg-search-no-result';
      noRes.className = 'msg-search-no-result';
      noRes.textContent = 'Ничего не найдено';
      container.appendChild(noRes);
    }
  }

  // ---- Realtime подписка ----
  function subscribeToMessages() {
    if (realtimeSubscription) {
      window.supabaseClient.removeChannel(realtimeSubscription);
    }

    realtimeSubscription = window.supabaseClient
      .channel(`messages-${currentUser.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${currentUser.id}`
        },
        async (payload) => {
          const newMsg = payload.new;

          // Игнорируем сообщения от заблокированных
          if (blockedUsers.has(newMsg.sender_id)) return;

          // Если это сообщение в открытом чате — добавляем его
          if (selectedChat && newMsg.sender_id === selectedChat.id) {
            appendMessage(newMsg);
            // Помечаем как прочитанное ТОЛЬКО если страница видима (пользователь активен)
            if (!document.hidden) {
              await markMessagesAsRead(selectedChat.id);
            } else {
              // Окно свёрнуто/скрыто — показываем уведомление даже для активного чата
              const senderProfile = allProfiles.find((p) => p.id === newMsg.sender_id);
              const name = senderProfile ? getContactDisplayName(senderProfile) : 'Новое сообщение';
              let preview;
              if (newMsg.file_name && newMsg.file_name.startsWith('vidnote_')) { preview = '🎥 Кружок'; }
              else if (newMsg.file_name && newMsg.file_name.startsWith('voice_')) { preview = '🎤 Голосовое сообщение'; }
              else if (newMsg.file_name) { preview = `📎 ${newMsg.file_name}`; }
              else {
                // Decrypt E2EE content before showing in notification
                const decrypted = await decryptMsg(newMsg);
                preview = decrypted.content || '';
              }
              showNativeNotification(name, preview, newMsg.sender_id);
            }
          } else {
            // Иначе — показываем уведомление
            const senderProfile = allProfiles.find((p) => p.id === newMsg.sender_id);
            const name = senderProfile ? getContactDisplayName(senderProfile) : 'Новое сообщение';
            let preview;
            if (newMsg.file_name && newMsg.file_name.startsWith('vidnote_')) {
              preview = '🎥 Кружок';
            } else if (newMsg.file_name && newMsg.file_name.startsWith('voice_')) {
              preview = '🎤 Голосовое сообщение';
            } else if (newMsg.file_name) {
              preview = `📎 ${newMsg.file_name}`;
            } else {
              // Decrypt E2EE content before showing in notification
              const decrypted = await decryptMsg(newMsg);
              preview = decrypted.content || '';
            }
            // Показываем уведомление (in-app пузырь + нативное + звук)
            showNativeNotification(name, preview, newMsg.sender_id);
          }

          // Обновляем список диалогов
          loadConversations();
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `sender_id=eq.${currentUser.id}`
        },
        (payload) => {
          // Обновляем галочки прочтения — только для СВОИХ сообщений
          if (payload.new.sender_id !== currentUser.id) return; // защита от чужих UPDATE
          const msgStatusWrap = document.querySelector(`[data-msg-id="${payload.new.id}"] .msg-read-status`);
          if (msgStatusWrap && payload.new.is_read) {
            const newTick = msgTickHTML('read');
            const tmp = document.createElement('div');
            tmp.innerHTML = newTick;
            msgStatusWrap.replaceWith(tmp.firstElementChild);
          }
          // Обновляем текст ТОЛЬКО если updated_at установлен (значит редактирование)
          // и content реально изменился относительно того что в DOM
          if (payload.new.updated_at) {
            const wrapper = document.querySelector(`[data-msg-id="${payload.new.id}"]`);
            if (wrapper) {
              const textEl = wrapper.querySelector('.msg-text');
              const domText = textEl ? textEl.textContent : null;
              if (textEl && payload.new.content && domText !== payload.new.content) {
                textEl.textContent = payload.new.content;
                if (!wrapper.querySelector('.msg-edited')) {
                  const mark = document.createElement('span');
                  mark.className = 'msg-edited';
                  mark.textContent = 'изменено';
                  const timeEl = wrapper.querySelector('.msg-time');
                  if (timeEl) timeEl.insertAdjacentElement('beforebegin', mark);
                }
              }
            }
          }
        }
      )
      // Обновления от собеседника (его редактирование)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${currentUser.id}`
        },
        (payload) => {
          if (payload.new.updated_at) {
            const wrapper = document.querySelector(`[data-msg-id="${payload.new.id}"]`);
            if (wrapper) {
              const textEl = wrapper.querySelector('.msg-text');
              const domText = textEl ? textEl.textContent : null;
              if (textEl && payload.new.content && domText !== payload.new.content) {
                textEl.textContent = payload.new.content;
                if (!wrapper.querySelector('.msg-edited')) {
                  const mark = document.createElement('span');
                  mark.className = 'msg-edited';
                  mark.textContent = 'изменено';
                  const timeEl = wrapper.querySelector('.msg-time');
                  if (timeEl) timeEl.insertAdjacentElement('beforebegin', mark);
                }
              }
            }
          }
        }
      )
      // Удаление для всех — убираем из UI
      // ВАЖНО: для payload.old нужен REPLICA IDENTITY FULL на таблице messages
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
          filter: `sender_id=eq.${currentUser.id}`
        },
        (payload) => {
          const msgId = payload.old?.id;
          if (msgId) {
            const el = document.querySelector(`[data-msg-id="${msgId}"]`);
            if (el) el.remove();
            renderedMessageIds.delete(msgId);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${currentUser.id}`
        },
        (payload) => {
          const msgId = payload.old?.id;
          if (msgId) {
            const el = document.querySelector(`[data-msg-id="${msgId}"]`);
            if (el) el.remove();
            renderedMessageIds.delete(msgId);
          }
        }
      )
      .subscribe();
  }

  // ---- Сжатие изображений (browser-image-compression) ----
  async function compressImage(file, opts = {}) {
    if (typeof imageCompression === 'undefined') return file;
    const options = {
      maxSizeMB:        opts.maxSizeMB        ?? 1,
      maxWidthOrHeight: opts.maxWidthOrHeight  ?? 1920,
      useWebWorker:     true,
      fileType:         opts.fileType         ?? 'image/jpeg',
      initialQuality:   opts.initialQuality   ?? 0.75,
    };
    try {
      const compressed = await imageCompression(file, options);
      // Сохраняем оригинальное имя файла, меняем расширение на .jpg если нужно
      const baseName = file.name.replace(/\.[^.]+$/, '');
      return new File([compressed], baseName + '.jpg', { type: compressed.type || 'image/jpeg' });
    } catch (err) {
      console.warn('[compressImage] ошибка сжатия:', err);
      return file; // фоллбэк — оригинал
    }
  }

  // ---- Работа с файлами ----
  // ---- Прогресс-оверлей при сжатии видео ----
  function _showVideoCompressProgress(container) {
    if (!container) return null;
    const overlay = document.createElement('div');
    overlay.className = 'video-compress-overlay';
    overlay.innerHTML = `
      <div class="video-compress-ring">
        <svg class="vcr-svg" viewBox="0 0 36 36">
          <circle class="vcr-bg" cx="18" cy="18" r="15.9"/>
          <circle class="vcr-arc" cx="18" cy="18" r="15.9" id="vcr-arc"/>
        </svg>
        <span class="vcr-pct" id="vcr-pct">0%</span>
      </div>
      <div class="vcr-label">Сжатие...</div>
    `;
    container.style.position = 'relative';
    container.appendChild(overlay);
    return {
      update(pct) {
        const arc = overlay.querySelector('#vcr-arc');
        const pctEl = overlay.querySelector('#vcr-pct');
        if (arc) {
          const circ = 2 * Math.PI * 15.9;
          arc.style.strokeDasharray = `${circ * pct / 100} ${circ}`;
        }
        if (pctEl) pctEl.textContent = Math.round(pct) + '%';
      },
      remove() { overlay.remove(); },
    };
  }

  // ---- Сжатие видео через canvas + MediaRecorder (VP9) ----
  async function compressVideo(file, progressContainer) {
    // Сжимаем только mp4/webm/mov если > 2MB
    if (file.size < 2 * 1024 * 1024) return file;
    if (!file.type.match(/^video\/(mp4|webm|quicktime|x-matroska|avi|3gpp|ogg)$/i)) return file;

    const progress = progressContainer ? _showVideoCompressProgress(progressContainer) : null;

    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      const url = URL.createObjectURL(file);
      video.src = url;

      video.onloadedmetadata = () => {
        const duration = video.duration || 0;
        video.currentTime = 0;
        video.oncanplay = () => {
          let w = video.videoWidth;
          let h = video.videoHeight;
          const maxDim = 720;
          if (w > maxDim || h > maxDim) {
            const ratio = Math.min(maxDim / w, maxDim / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }

          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          const stream = canvas.captureStream(24);

          try {
            const audioCtx = new AudioContext();
            const source = audioCtx.createMediaElementSource(video);
            const dest = audioCtx.createMediaStreamDestination();
            source.connect(dest);
            source.connect(audioCtx.destination);
            dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
          } catch {}

          const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
            ? 'video/webm;codecs=vp8'
            : 'video/webm';

          // Адаптивный битрейт: чем больше файл, тем агрессивнее сжатие
          const sizeMB = file.size / (1024 * 1024);
          const vBitrate = sizeMB > 50 ? 500_000 : sizeMB > 20 ? 600_000 : 800_000;
          const recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: vBitrate,
            audioBitsPerSecond: 48_000,
          });
          const chunks = [];
          recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
          recorder.onstop = () => {
            URL.revokeObjectURL(url);
            progress && progress.remove();
            const blob = new Blob(chunks, { type: mimeType });
            if (blob.size >= file.size) { resolve(file); return; }
            const baseName = file.name.replace(/\.[^.]+$/, '');
            resolve(new File([blob], baseName + '.webm', { type: mimeType }));
          };

          recorder.start();
          video.play();

          function drawFrame() {
            if (video.ended || video.paused) { recorder.stop(); return; }
            ctx.drawImage(video, 0, 0, w, h);
            // Обновляем прогресс по текущему времени видео
            if (progress && duration > 0) {
              progress.update(Math.min(99, (video.currentTime / duration) * 100));
            }
            requestAnimationFrame(drawFrame);
          }
          drawFrame();
          video.onended = () => { if (progress) progress.update(100); recorder.stop(); };

          setTimeout(() => {
            if (recorder.state === 'recording') { video.pause(); recorder.stop(); }
          }, 180_000);
        };
      };
      video.onerror = () => { URL.revokeObjectURL(url); progress && progress.remove(); resolve(file); };
    });
  }

  async function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    // Несколько изображений — мультивыбор
    if (files.length > 1) {
      const validFiles = files.filter(f => f.size <= MAX_FILE_SIZE);
      if (validFiles.length < files.length) {
        showToast(`${files.length - validFiles.length} файл(ов) превышают 25 МБ — пропущены`, 'warning');
      }
      selectedFiles = [];
      for (const f of validFiles) {
        if (f.type.startsWith('image/')) {
          selectedFiles.push(await compressImage(f, { maxSizeMB: 1, maxWidthOrHeight: 1920, initialQuality: 0.75 }));
        } else if (f.type.startsWith('video/')) {
          showToast('Сжатие видео...', 'info');
          selectedFiles.push(await compressVideo(f));
        } else {
          selectedFiles.push(f);
        }
      }
      selectedFile = selectedFiles[0] || null;
      renderMultiFilePreview(selectedFiles);
      return;
    }

    // Один файл
    const file = files[0];
    if (file.size > MAX_FILE_SIZE) {
      showToast('Файл слишком большой. Максимум 25 МБ.', 'error');
      e.target.value = '';
      return;
    }

    if (file.type.startsWith('image/')) {
      const compressed = await compressImage(file, {
        maxSizeMB: 1,
        maxWidthOrHeight: 1920,
        initialQuality: 0.75,
      });
      selectedFiles = [compressed];
      selectedFile = compressed;
      renderFilePreview(compressed);
    } else if (file.type.startsWith('video/')) {
      // Сразу показываем превью, поверх него кружок прогресса
      selectedFiles = [file];
      selectedFile = file;
      renderFilePreview(file);
      const previewEl = getEl('file-preview');
      const compressed = await compressVideo(file, previewEl);
      selectedFiles = [compressed];
      selectedFile = compressed;
      // Обновляем превью сжатым файлом (имя/размер)
      renderFilePreview(compressed);
    } else {
      selectedFiles = [file];
      selectedFile = file;
      renderFilePreview(file);
    }
  }

  function renderMultiFilePreview(files) {
    const preview = getEl('file-preview');
    if (!preview) return;
    preview.classList.add('visible');
    const thumbs = files.map((f, i) => {
      if (f.type.startsWith('image/')) {
        return `<div class="multi-file-thumb" data-idx="${i}">
          <img id="mfthumb-${i}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;display:block;" alt="${escapeHTML(f.name)}">
          <button class="mf-remove-btn" onclick="Chat._removeSelectedFile(${i})">✕</button>
        </div>`;
      }
      return `<div class="multi-file-thumb" data-idx="${i}">
        <span style="font-size:24px;">${getFileIcon(f.type)}</span>
        <button class="mf-remove-btn" onclick="Chat._removeSelectedFile(${i})">✕</button>
      </div>`;
    }).join('');
    preview.innerHTML = `
      <div class="multi-file-preview">
        <div class="multi-file-thumbs">${thumbs}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${files.length} файл(ов)</div>
        <button class="file-preview-remove" onclick="Chat.clearSelectedFile()">✕ Убрать все</button>
      </div>`;
    // Загружаем превью изображений
    files.forEach((f, i) => {
      if (f.type.startsWith('image/')) {
        const img = document.getElementById(`mfthumb-${i}`);
        if (img) {
          const reader = new FileReader();
          reader.onload = ev => { img.src = ev.target.result; };
          reader.readAsDataURL(f);
        }
      }
    });
    updateSendBtnVisibility();
  }

  function _removeSelectedFile(idx) {
    selectedFiles.splice(idx, 1);
    selectedFile = selectedFiles[0] || null;
    if (selectedFiles.length === 0) {
      clearSelectedFile();
    } else if (selectedFiles.length === 1) {
      renderFilePreview(selectedFiles[0]);
    } else {
      renderMultiFilePreview(selectedFiles);
    }
  }

  function renderFilePreview(file) {
    const preview = getEl('file-preview');
    if (!preview) return;

    preview.classList.add('visible');

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        preview.innerHTML = `
          <div class="file-preview-content">
            <img src="${e.target.result}" alt="preview" class="file-preview-img">
            <div class="file-preview-info">
              <span class="file-preview-name">${escapeHTML(file.name)}</span>
              <span class="file-preview-size">${formatFileSize(file.size)}</span>
            </div>
            <button class="file-preview-remove" onclick="Chat.clearSelectedFile()">✕</button>
          </div>
        `;
      };
      reader.readAsDataURL(file);
    } else {
      preview.innerHTML = `
        <div class="file-preview-content">
          <span class="file-preview-icon">${getFileIcon(file.type)}</span>
          <div class="file-preview-info">
            <span class="file-preview-name">${escapeHTML(file.name)}</span>
            <span class="file-preview-size">${formatFileSize(file.size)}</span>
          </div>
          <button class="file-preview-remove" onclick="Chat.clearSelectedFile()">✕</button>
        </div>
      `;
    }
    updateSendBtnVisibility();
  }

  function clearSelectedFile() {
    selectedFile = null;
    selectedFiles = [];
    const preview = getEl('file-preview');
    if (preview) {
      preview.classList.remove('visible');
      preview.innerHTML = '';
    }
    const fileInput = getEl('file-input');
    if (fileInput) fileInput.value = '';
    updateSendBtnVisibility();
  }

  // ---- Drag & Drop файлов в чат ----
  function initDragAndDrop() {
    const chatView = document.querySelector('.main-chat') || document.querySelector('.chat-view') || document.getElementById('chat-view');
    if (!chatView) return;

    let dragCounter = 0;

    chatView.addEventListener('dragenter', (e) => {
      if (!selectedChat && !selectedGroup) return;
      e.preventDefault();
      dragCounter++;
      chatView.classList.add('drag-over');
    });

    chatView.addEventListener('dragleave', (e) => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        chatView.classList.remove('drag-over');
      }
    });

    chatView.addEventListener('dragover', (e) => {
      if (!selectedChat && !selectedGroup) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    chatView.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      chatView.classList.remove('drag-over');

      if (!selectedChat && !selectedGroup) return;

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      const file = files[0];
      if (file.size > MAX_FILE_SIZE) {
        showToast('Файл слишком большой. Максимум 25 МБ.', 'error');
        return;
      }

      let fileToUse = file;
      if (file.type.startsWith('image/')) {
        fileToUse = await compressImage(file, {
          maxSizeMB: 1,
          maxWidthOrHeight: 1920,
          initialQuality: 0.75,
        });
      }

      selectedFile = fileToUse;
      renderFilePreview(fileToUse);
      updateSendBtnVisibility();

      // Фокус на поле ввода
      const input = getEl('message-input');
      if (input) input.focus();
    });
  }

  // ---- Профиль пользователя (модальное окно) ----
  async function showUserProfile(userId) {
    const modal = getEl('profile-modal');
    if (!modal) return;

    modal.classList.add('visible');

    let profile = allProfiles.find((p) => p.id === userId);
    if (!profile) {
      const { data } = await window.supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      profile = data;
    }

    if (!profile) {
      modal.classList.remove('visible');
      return;
    }

    const content = getEl('profile-modal-content');
    if (!content) return;

    const memberSince = new Date(profile.created_at).toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric'
    });

    const isBlocked = blockedUsers.has(profile.id);
    const isSelf = profile.id === currentUser?.id;
    const isABot = isBot(profile);

    const blockActionBtn = (!isSelf && !isABot) ? `
      <button
        class="profile-block-btn ${isBlocked ? 'profile-block-btn--blocked' : ''}"
        onclick="Chat.toggleBlockFromProfile('${profile.id}')"
      >
        ${isBlocked
          ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg> Разблокировать`
          : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Заблокировать`
        }
      </button>
    ` : '';

    const isInContacts = trustedUsers.has(profile.id);
    const contactBtn = (!isSelf && !isABot) ? (
      isInContacts
        ? `<button class="profile-edit-contact-btn" onclick="Chat.openContactEditModal('${profile.id}'); Chat.closeProfileModal();">✎ Редактировать контакт</button>`
        : `<button class="profile-add-contact-btn" onclick="Chat.addContactFromProfile('${profile.id}');">✚ Добавить в контакты</button>`
    ) : '';

    content.innerHTML = `
      <div class="profile-modal-header">
        <div class="profile-modal-avatar">
          ${getAvatarHTML(profile, 80)}
        </div>
        <h2 class="profile-modal-name" style="display:flex;align-items:center;justify-content:center;gap:6px;">${escapeHTML(getDisplayName(profile))}${getUserBadge(profile)}</h2>
        <p class="profile-modal-handle">@${escapeHTML(profile.username)}</p>
        <p class="profile-modal-since">Участник с ${memberSince}</p>
      </div>
      <div class="profile-modal-actions">
        ${!isSelf ? `<button class="btn-primary" onclick="Chat.openChatWithUser('${profile.id}'); Chat.closeProfileModal();">💬 Написать</button>` : ''}
        ${contactBtn}
        ${blockActionBtn}
      </div>
      ${!isSelf && !isABot ? `
      <div class="pm-media-section">
        <div class="pm-media-tabs">
          <button class="pm-media-tab active" data-tab="photo" onclick="Chat.switchProfileMediaTab('${profile.id}', 'photo', this)">Фото</button>
          <button class="pm-media-tab" data-tab="media" onclick="Chat.switchProfileMediaTab('${profile.id}', 'media', this)">Медиа</button>
          <button class="pm-media-tab" data-tab="files" onclick="Chat.switchProfileMediaTab('${profile.id}', 'files', this)">Файлы</button>
        </div>
        <div id="pm-media-content" class="pm-media-content">
          <div class="pm-media-loading">Загрузка...</div>
        </div>
      </div>` : ''}
    `;
    if (!isSelf && !isABot) {
      _loadProfileMedia(profile.id, 'photo');
    }
  }

  function closeProfileModal() {
    const modal = getEl('profile-modal');
    if (modal) modal.classList.remove('visible');
  }

  // ============================================================
  // ---- Медиа-вкладки: профиль (DM) ----
  // ============================================================

  function switchProfileMediaTab(userId, tab, btn) {
    document.querySelectorAll('.pm-media-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const c = document.getElementById('pm-media-content');
    if (c) c.innerHTML = '<div class="pm-media-loading">Загрузка...</div>';
    _loadProfileMedia(userId, tab);
  }

  async function _loadProfileMedia(userId, tab) {
    const c = document.getElementById('pm-media-content');
    if (!c || !currentUser) return;
    try {
      const { data } = await window.supabaseClient
        .from('messages')
        .select('id, file_url, file_name, file_type, file_size, created_at')
        .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${userId}),and(sender_id.eq.${userId},receiver_id.eq.${currentUser.id})`)
        .not('file_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(200);

      const msgs = data || [];
      let filtered;
      if (tab === 'photo') {
        filtered = msgs.filter(m => m.file_type && m.file_type.startsWith('image/'));
      } else if (tab === 'media') {
        filtered = msgs.filter(m =>
          (m.file_name && m.file_name.startsWith('vidnote_')) ||
          (m.file_type && (m.file_type.startsWith('audio/') || m.file_type.startsWith('video/')))
        );
      } else {
        filtered = msgs.filter(m =>
          m.file_type &&
          !m.file_type.startsWith('image/') &&
          !m.file_type.startsWith('audio/') &&
          !m.file_type.startsWith('video/') &&
          !(m.file_name && m.file_name.startsWith('vidnote_'))
        );
      }

      if (!filtered.length) {
        const labels = { photo: 'фотографий', media: 'медиафайлов', files: 'файлов' };
        c.innerHTML = `<div class="pm-media-empty">Нет ${labels[tab] || 'файлов'}</div>`;
        return;
      }

      if (tab === 'photo') {
        c.innerHTML = `<div class="pm-photo-grid">${filtered.map(m =>
          `<div class="pm-photo-thumb" onclick="Chat.openImageModal('${escapeHTML(m.file_url)}')">
            <img src="${escapeHTML(m.file_url)}" alt="" loading="lazy">
          </div>`
        ).join('')}</div>`;
      } else {
        c.innerHTML = filtered.map(m => {
          const icon = (m.file_name && m.file_name.startsWith('vidnote_')) ? '🎥' :
            (m.file_type && m.file_type.startsWith('audio/')) ? '🎵' : getFileIcon(m.file_type);
          const name = m.file_name ? escapeHTML(m.file_name) : 'Файл';
          const size = m.file_size ? `<span class="pm-file-size">${_fmtBytes(m.file_size)}</span>` : '';
          return `<div class="pm-file-row">
            <div class="pm-file-icon">${icon}</div>
            <div class="pm-file-info"><div class="pm-file-name">${name}</div>${size}</div>
            <a href="${escapeHTML(m.file_url)}" target="_blank" rel="noopener noreferrer" class="pm-file-dl" title="Скачать">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </a>
          </div>`;
        }).join('');
      }
    } catch {
      c.innerHTML = '<div class="pm-media-empty">Ошибка загрузки</div>';
    }
  }

  function _fmtBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' КБ';
    return (bytes / 1048576).toFixed(1) + ' МБ';
  }

  // ============================================================
  // ---- Медиа-вкладки: группа ----
  // ============================================================

  function switchGroupMediaTab(tab, btn) {
    document.querySelectorAll('.gip-media-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const c = document.getElementById('gip-media-content');
    if (c) c.innerHTML = '<div class="pm-media-loading">Загрузка...</div>';
    _loadGroupMedia(tab);
  }

  async function _loadGroupMedia(tab) {
    const c = document.getElementById('gip-media-content');
    if (!c || !selectedGroup) return;
    try {
      const { data } = await window.supabaseClient
        .from('group_messages')
        .select('id, file_url, file_name, file_type, file_size, created_at')
        .eq('group_id', selectedGroup.id)
        .not('file_url', 'is', null)
        .order('created_at', { ascending: false })
        .limit(200);

      const msgs = data || [];
      let filtered;
      if (tab === 'photo') {
        filtered = msgs.filter(m => m.file_type && m.file_type.startsWith('image/'));
      } else if (tab === 'media') {
        filtered = msgs.filter(m =>
          (m.file_name && m.file_name.startsWith('vidnote_')) ||
          (m.file_type && (m.file_type.startsWith('audio/') || m.file_type.startsWith('video/')))
        );
      } else {
        filtered = msgs.filter(m =>
          m.file_type &&
          !m.file_type.startsWith('image/') &&
          !m.file_type.startsWith('audio/') &&
          !m.file_type.startsWith('video/') &&
          !(m.file_name && m.file_name.startsWith('vidnote_'))
        );
      }

      if (!filtered.length) {
        const labels = { photo: 'фотографий', media: 'медиафайлов', files: 'файлов' };
        c.innerHTML = `<div class="pm-media-empty">Нет ${labels[tab] || 'файлов'}</div>`;
        return;
      }

      if (tab === 'photo') {
        c.innerHTML = `<div class="pm-photo-grid">${filtered.map(m =>
          `<div class="pm-photo-thumb" onclick="Chat.openImageModal('${escapeHTML(m.file_url)}')">
            <img src="${escapeHTML(m.file_url)}" alt="" loading="lazy">
          </div>`
        ).join('')}</div>`;
      } else {
        c.innerHTML = filtered.map(m => {
          const icon = (m.file_name && m.file_name.startsWith('vidnote_')) ? '🎥' :
            (m.file_type && m.file_type.startsWith('audio/')) ? '🎵' : getFileIcon(m.file_type);
          const name = m.file_name ? escapeHTML(m.file_name) : 'Файл';
          const size = m.file_size ? `<span class="pm-file-size">${_fmtBytes(m.file_size)}</span>` : '';
          return `<div class="pm-file-row">
            <div class="pm-file-icon">${icon}</div>
            <div class="pm-file-info"><div class="pm-file-name">${name}</div>${size}</div>
            <a href="${escapeHTML(m.file_url)}" target="_blank" rel="noopener noreferrer" class="pm-file-dl" title="Скачать">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </a>
          </div>`;
        }).join('');
      }
    } catch {
      c.innerHTML = '<div class="pm-media-empty">Ошибка загрузки</div>';
    }
  }

  // ============================================================
  // ---- «Цифровая вежливость» — отправить когда в сети ----
  // ============================================================

  function toggleSendWhenOnline() {
    sendWhenOnlineMode = !sendWhenOnlineMode;
    const btn = document.getElementById('send-online-btn');
    if (btn) {
      btn.classList.toggle('active', sendWhenOnlineMode);
      // Анимация стрелок часов — перемотка 24 часа (два полных оборота)
      btn.classList.remove('anim-clock');
      void btn.offsetWidth;
      btn.classList.add('anim-clock');
      btn.addEventListener('animationend', () => btn.classList.remove('anim-clock'), { once: true });
    }
    showToast(sendWhenOnlineMode
      ? '⏰ Режим «отправить когда в сети» включён'
      : '⏰ Режим «отправить когда в сети» выключен', 'info');
  }

  function _updateSendOnlineBtn() {
    const btn = document.getElementById('send-online-btn');
    if (!btn) return;
    const isDM = !!(selectedChat && !selectedGroup && !(window.Channels && window.Channels.selectedChannel));
    btn.style.display = isDM ? '' : 'none';
    if (!isDM && sendWhenOnlineMode) {
      sendWhenOnlineMode = false;
      btn.classList.remove('active');
    }
  }

  function _subscribeSendWhenOnlinePresence(partnerId) {
    if (sendWhenOnlinePresenceSub) {
      try { window.supabaseClient.removeChannel(sendWhenOnlinePresenceSub); } catch {}
      sendWhenOnlinePresenceSub = null;
    }
    sendWhenOnlinePresenceSub = window.supabaseClient
      .channel(`swo-presence-${partnerId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'profiles',
        filter: `id=eq.${partnerId}`
      }, (payload) => {
        if (payload.new && payload.new.last_seen) {
          const status = formatLastSeen(payload.new.last_seen);
          if (status === 'в сети') {
            _flushSendWhenOnlineQueue(partnerId);
          }
        }
      })
      .subscribe();
  }

  async function _flushSendWhenOnlineQueue(partnerId) {
    const toSend = pendingOnlineMessages.filter(m => m.partner_id === partnerId);
    if (!toSend.length) return;

    // Remove from pending list first
    pendingOnlineMessages = pendingOnlineMessages.filter(m => m.partner_id !== partnerId);

    // Send to DB + render real messages for the sender
    for (const m of toSend) {
      // Remove the pending UI element
      const pendingEl = document.querySelector(`[data-local-id="${m.local_id}"]`);
      if (pendingEl) pendingEl.remove();

      try {
        const { data: inserted } = await window.supabaseClient.from('messages').insert({
          sender_id: currentUser.id,
          receiver_id: partnerId,
          content: m.content || null,
          file_url: m.file_url || null,
          file_name: m.file_name || null,
          file_type: m.file_type || null,
          file_size: m.file_size || null,
        }).select().single();

        // Render the real message for the sender (realtime only catches receiver_id events)
        if (inserted && selectedChat && selectedChat.id === partnerId) {
          await appendMessage(inserted);
        }
      } catch (e) {
        console.error('[SWO] Failed to send queued message:', e);
      }
    }

    showToast('✅ Сообщения отправлены (собеседник в сети)', 'success');

    // Unsubscribe if no more pending
    if (!pendingOnlineMessages.some(m => m.partner_id === partnerId)) {
      if (sendWhenOnlinePresenceSub) {
        try { window.supabaseClient.removeChannel(sendWhenOnlinePresenceSub); } catch {}
        sendWhenOnlinePresenceSub = null;
      }
    }
  }

  function _renderPendingOnlineMessage(msg) {
    const container = getEl('messages-container');
    if (!container) return;
    const noMsg = container.querySelector('.no-messages');
    if (noMsg) noMsg.remove();

    const el = document.createElement('div');
    el.className = 'gm-wrapper gm-own pending-online-msg';
    el.setAttribute('data-local-id', msg.local_id);
    let bodyHTML = '';
    if (msg.file_url) {
      if (msg.file_type && msg.file_type.startsWith('image/')) {
        bodyHTML = `<img src="${escapeHTML(msg.file_url)}" class="msg-image" style="max-width:200px;border-radius:8px;">`;
      } else {
        bodyHTML = `<div class="msg-file"><span class="msg-file-icon">${getFileIcon(msg.file_type)}</span><span class="msg-file-name">${escapeHTML(msg.file_name || 'файл')}</span></div>`;
      }
    }
    if (msg.content) {
      bodyHTML += `<div class="msg-text">${escapeHTML(msg.content)}</div>`;
    }
    el.innerHTML = `
      <div class="gm-bubble">
        <div class="pending-online-badge">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Ожидает пользователя в сети
        </div>
        ${bodyHTML}
        <div class="gm-meta" style="justify-content:flex-end;">
          <span class="msg-time">${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
          <svg class="msg-read-status" width="16" height="10" viewBox="0 0 16 10" fill="none" stroke="var(--text-muted)" stroke-width="1.8" stroke-linecap="round" style="opacity:0.6;"><circle cx="8" cy="5" r="3"/></svg>
        </div>
      </div>
    `;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.querySelectorAll('.msg-context-menu').forEach(m => m.remove());
      const ctxMenu = document.createElement('div');
      ctxMenu.className = 'msg-context-menu';
      ctxMenu.innerHTML = `<button class="msg-ctx-item msg-ctx-item--danger" data-action="cancel">🗑️ Удалить (не отправлять)</button>`;
      document.body.appendChild(ctxMenu);
      ctxMenu.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        ctxMenu.remove();
        pendingOnlineMessages = pendingOnlineMessages.filter(pm => pm.local_id !== msg.local_id);
        el.remove();
        if (pendingOnlineMessages.length === 0 && sendWhenOnlinePresenceSub) {
          try { window.supabaseClient.removeChannel(sendWhenOnlinePresenceSub); } catch {}
          sendWhenOnlinePresenceSub = null;
        }
      });
      let cx = e.clientX, cy = e.clientY;
      ctxMenu.style.left = '0px'; ctxMenu.style.top = '-9999px';
      requestAnimationFrame(() => {
        const mh = ctxMenu.offsetHeight, mw = ctxMenu.offsetWidth;
        if (cx + mw > window.innerWidth) cx = window.innerWidth - mw - 8;
        if (cy + mh > window.innerHeight) cy = cy - mh - 8;
        ctxMenu.style.left = cx + 'px'; ctxMenu.style.top = cy + 'px';
      });
      const closeCtx = (ev) => { if (!ctxMenu.contains(ev.target)) { ctxMenu.remove(); document.removeEventListener('click', closeCtx); } };
      setTimeout(() => document.addEventListener('click', closeCtx), 10);
    });
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  // ---- Добавить в контакты из профиля ----
  async function addContactFromProfile(userId) {
    closeProfileModal();
    // Добавляем в доверенные контакты
    await addContact(userId);
    // Открываем форму редактирования (с уже заполненными именем и фото)
    // с небольшой задержкой чтобы модал успел закрыться
    setTimeout(() => openContactEditModal(userId), 150);
  }

  async function toggleBlockFromProfile(userId) {
    closeProfileModal();
    if (blockedUsers.has(userId)) {
      // Разблокируем — выставляем selectedChat чтобы unblockUser знал кого
      const profile = allProfiles.find(p => p.id === userId);
      if (profile) selectedChat = profile;
      await unblockUser(); // unblockUser теперь сам обновляет шапку
    } else {
      // Показываем подтверждение перед блокировкой
      showBlockConfirmation(userId);
    }
  }

  // ---- Модальное окно изображения ----
  function openImageModal(url) {
    const modal = getEl('image-modal');
    const img = getEl('image-modal-img');
    if (!modal || !img) return;
    img.src = url;
    modal.classList.add('visible');
  }

  function closeImageModal() {
    const modal = getEl('image-modal');
    if (modal) modal.classList.remove('visible');
  }

  // ================================================================
  //  EMOJI PICKER
  // ================================================================
  const _emojiData = {
    '😊 Смайлы': ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😠','😡','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'],
    '🧑 Люди':   ['👋','🤚','🖐','✋','🖖','🤙','👌','🤌','🤏','✌️','🤞','🖕','👆','👇','👈','👉','☝️','👍','👎','✊','👊','🤛','🤜','🤝','👏','🙌','👐','🤲','🙏','✍️','💅','🤳','💪','🦾','👂','🦻','👃','🧠','👀','👁','🫦','👶','👧','👦','🧒','👩','👨','🧑','👴','👵','🧓','👮','💂','🕵️','👷','🤴','👸','👰','🤵','🦸','🦹','🧙','🧝','🧛','🧟','🧞','🧜','🧚','🤶','🎅','🧑‍⚕️','🧑‍🎓','🧑‍🏫','🧑‍⚖️','🧑‍🌾','🧑‍🍳','🧑‍🔧','🧑‍🏭','🧑‍💼','🧑‍🔬','🧑‍🎤','🧑‍🎨','🧑‍✈️','🧑‍🚀','🧑‍🚒'],
    '🐾 Природа': ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦟','🦗','🕷','🦂','🐢','🐍','🦎','🦕','🦖','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🐘','🦛','🦏','🐪','🦒','🦘','🐃','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐈','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿','🦔','🌲','🌳','🌴','🌱','🌿','🌾','🍀','🌺','🌸','🌼','🌻','🌹','🥀','🌷','🍄','🌵','🎋','🎍','🍁','🍂','🍃','🌊','💧','💦','❄️','☃️','🌈','🔥','⭐','🌟','💫','✨','🌙','☀️','🌤','⛅','🌧','⛈','🌩','🌨','🌀'],
    '🍕 Еда':    ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🧄','🧅','🥔','🌽','🥕','🥜','🌰','🍞','🥐','🥖','🫓','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🌮','🌯','🥙','🧆','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🥟','🥠','🥡','🦪','🍦','🍧','🍨','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯','🍼','🥛','☕','🫖','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾','🧊'],
    '⚽ Занятия': ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🏒','🏑','🏏','🥅','⛳','🎣','🤿','🥊','🥋','🎽','🛹','🛷','⛸','🎿','⛷','🏂','🏋️','🤸','🤺','🤼','🤻','🤾','🤽','🏇','🧘','🏄','🏊','🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖','🏵','🎗','🎫','🎟','🎪','🤹','🎭','🎨','🎰','🎢','🎡','🎠','🎬','🎤','🎧','🎼','🎵','🎶','🎹','🥁','🪘','🎷','🎺','🪗','🎸','🪕','🎻','🎲','♟','🃏','🎮','🕹'],
    '✈️ Места':  ['🚗','🚕','🚙','🚌','🚑','🚒','🚓','🚜','🚛','🚚','🛻','🏎','🏍','🛵','🚲','🛴','⛵','🚤','🛥','🚢','✈️','🛩','🛫','🛬','💺','🚁','🚀','🛸','🛎','🧳','🌍','🌎','🌏','🗺','🧭','🏔','⛰','🌋','🗻','🏕','🏖','🏜','🏝','🏞','🏟','🏛','🏗','🏘','🏠','🏡','🏢','🏣','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','🌁','🌃','🌄','🌅','🌆','🌇','🌉','🌌','🎆','🎇','⛩','🗽','🗼','⛲','⛺','🌐','🗾'],
    '💡 Объекты': ['💌','💣','🪤','💰','💴','💵','💸','💳','📈','📉','📊','📋','📅','📆','📇','📃','📑','📄','🗞','📰','📌','📍','✂️','🗑','🔒','🔓','🔑','🗝','🔨','🪓','⛏','🛠','⚔️','🛡','🔧','🪛','🔩','⚙️','🧰','🧲','🪜','🔬','🔭','📡','💉','🩸','💊','🩹','🩺','🩻','🚪','🛗','🪞','🪟','🛏','🛋','🪑','🚽','🚿','🛁','🧴','🧹','🧺','🧻','🧼','🪥','🪒','🧽','🧯','🛒','🎁','🎀','🎊','🎉','🎈','🧧','🪔','💡','🔦','🏮','🧱','📦','📫','📪','📬','📭','📮','🖊','🖋','✒️','✏️','📝','🔍','🔎','📏','📐','💼','👝','👛','👜','🎒','🧳','👓','🕶','🥽','🌂','🎩','🧢','👒','🎓','💍','💎','👔','👕','👖','👗','👘','👙','🧣','🧤','🧥','👠','👡','👢','👞','👟','🥾','🥿','⌚','📱','📲','💻','⌨️','🖥','🖨','🖱','🖲','📷','📸','📹','🎥','📽','🎞','📞','☎️','📟','📠','📺','📻','🧭','⏰','🕰','⌛','⏳','🔋','🔌','💡','🔦','🕯','💿','📀','💾','💽','📼','📷'],
    '🔣 Символы': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉','☸️','✡️','🔯','🕎','☯️','☦️','🛐','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','⛎','🔰','♻️','✅','❎','🆗','🆙','🆕','🆒','🆓','🆖','🆚','⁉️','❓','❔','❕','❗','‼️','🔅','🔆','🔱','⚜️','📵','🔞','⭕','✖️','❌','⛔','🚫','💯','💢','💬','💭','💤','🔊','🔉','🔈','🔇','📣','📢','🔔','🔕','🔀','🔁','🔂','⏩','⏪','⏫','⏬','⏭','⏮','⏯','▶️','⏸','⏹','⏺','🔮','🪄','💊','🧪','🌡','♠️','♥️','♦️','♣️','♟️','🃏','🀄','🎴','🔐','🔏','🔒','🔓','🔑','🗝'],
    '🚩 Флаги':  ['🇷🇺','🇺🇸','🇨🇳','🇬🇧','🇩🇪','🇫🇷','🇯🇵','🇰🇷','🇮🇹','🇪🇸','🇧🇷','🇨🇦','🇦🇺','🇮🇳','🇲🇽','🇸🇦','🇹🇷','🇦🇷','🇿🇦','🇳🇱','🇨🇭','🇸🇪','🇳🇴','🇩🇰','🇫🇮','🇵🇱','🇺🇦','🇨🇿','🇦🇹','🇭🇺','🇷🇴','🇧🇬','🇬🇷','🇮🇱','🇸🇬','🇭🇰','🇹🇭','🇮🇩','🇲🇾','🇵🇭','🇻🇳','🇳🇿','🇵🇰','🇧🇩','🇳🇬','🇰🇪','🇪🇬','🇮🇷','🇮🇶','🇦🇪','🇵🇹','🇧🇪','🇮🇪','🇦🇿','🇰🇿','🇺🇿','🇧🇾','🇲🇩','🇦🇲','🇬🇪','🇹🇳','🇲🇦','🇦🇱','🇷🇸','🇭🇷','🇧🇦','🇸🇮','🇸🇰','🇱🇹','🇱🇻','🇪🇪','🇮🇸','🇲🇹','🇨🇾','🇱🇺','🇲🇨','🇦🇩','🇱🇮','🇸🇲','🇻🇦','🇲🇰','🇲🇪','🇽🇰']
  };
  let _emojiCurrentCat = Object.keys(_emojiData)[0];
  let _emojiPickerInited = false;

  function _initEmojiPicker() {
    if (_emojiPickerInited) return;
    _emojiPickerInited = true;
    _renderEmojiGridAll();
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function _closeEmojiOutside(e) {
        const picker = getEl('emoji-picker');
        const btn = getEl('emoji-btn');
        if (picker && !picker.contains(e.target) && e.target !== btn) {
          picker.style.display = 'none';
        }
      });
    }, 50);
  }

  // Единые параметры Twemoji (SVG-ассеты загружаются с GitHub CDN по необходимости)
  const _TW_OPTS = { base: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/', folder: 'svg', ext: '.svg' };
  function _applyTwemoji(el) {
    if (!el || !window.twemoji) return;
    // На Android/Capacitor не применяем twemoji — нативные emoji Android отлично работают,
    // а CDN-картинки грузятся долго или не грузятся вообще → emoji пропадают
    if (_isAndroid || _isCapacitor) return;
    twemoji.parse(el, _TW_OPTS);
  }

  // Рендер всех категорий в один прокручиваемый список
  function _renderEmojiGridAll() {
    const grid = getEl('emoji-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    Object.entries(_emojiData).forEach(([cat, emojis]) => {
      const header = document.createElement('div');
      header.className = 'emoji-cat-header';
      header.textContent = cat;
      frag.appendChild(header);

      const row = document.createElement('div');
      row.className = 'emoji-row';
      emojis.forEach(em => {
        const btn = document.createElement('button');
        btn.className = 'emoji-item';
        btn.textContent = em;
        btn.title = em;
        btn.onclick = (e) => { e.stopPropagation(); _insertEmoji(em); };
        row.appendChild(btn);
      });
      frag.appendChild(row);
    });
    grid.appendChild(frag);
    _applyTwemoji(grid);
  }

  function _renderEmojiGrid(catOrList, isSearch) {
    const grid = getEl('emoji-grid');
    if (!grid) return;
    const list = isSearch ? catOrList : _emojiData[catOrList] || [];
    grid.innerHTML = '';
    if (list.length === 0) {
      grid.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px;text-align:center;">Ничего не найдено</div>';
      return;
    }
    const row = document.createElement('div');
    row.className = 'emoji-row';
    row.style.cssText = 'flex-wrap:wrap;display:flex;gap:1px;';
    list.forEach(em => {
      const btn = document.createElement('button');
      btn.className = 'emoji-item';
      btn.textContent = em;
      btn.title = em;
      btn.onclick = (e) => { e.stopPropagation(); _insertEmoji(em); };
      row.appendChild(btn);
    });
    grid.appendChild(row);
    _applyTwemoji(grid);
  }

  // Названия эмодзи (RU + EN) для поиска
  const _emojiNames = {
    '😀':'улыбка grinning','😃':'радость joy','😄':'смех laugh','😁':'ухмылка grin','😆':'смеяться laughing','😅':'пот sweat smile','🤣':'катаюсь смею rofl','😂':'слёзы смех tears joy','🙂':'слегка улыбаюсь slightly smile','🙃':'перевёрнутый upside down','😉':'подмигиваю wink','😊':'улыбка blush smile','😇':'ангел angel','🥰':'влюблён hearts love','😍':'глаза сердечки heart eyes love','🤩':'звезды в глазах star struck','😘':'целую kiss','😗':'поцелуй kissing','😚':'поцелуй kiss','😙':'целую улыбка kiss','🥲':'улыбка слеза smile tear','😋':'вкусно yum','😛':'язык tongue','😜':'подмигиваю язык wink tongue','🤪':'безумие crazy zany','😝':'язык smile tongue','🤑':'деньги money','🤗':'обнимаю hugging','🤭':'рот закрыт hand over mouth','🤫':'тссс shush quiet','🤔':'думаю thinking','🤐':'молчу zipper mouth','🤨':'подозрение raised eyebrow','😐':'нейтральный neutral','😑':'без выражения expressionless','😶':'без рта no mouth','😏':'ухмыляюсь smirk','😒':'недовольный unamused','🙄':'глаза вверх eye roll','😬':'гримаса grimace','😌':'облегчение relieved','😔':'грустный pensive sad','😪':'сонный sleepy','🤤':'слюна drool','😴':'сплю sleeping','😷':'маска mask sick','🤒':'болею sick','🤕':'травма injury','🤢':'тошнота nauseated sick','🤮':'рвота vomit','🤧':'чихаю sneezing','🥵':'жарко hot','🥶':'холодно cold','🥴':'мутный woozy','😵':'головокружение dizzy','🤯':'взрыв голова exploding head','🤠':'ковбой cowboy','🥳':'вечеринка partying','🥸':'инкогнито disguise','😎':'круто cool','🤓':'очкарик nerd','🧐':'монокль monocle','😕':'смущён confused','😟':'беспокойство worried','🙁':'грусть sad','☹️':'грустный frowning','😮':'удивление surprised','😯':'изумление hushed','😲':'шок astonished','😳':'смущение flushed','🥺':'пожалуйста pleading','😦':'озабочен frowning','😧':'страдание anguished','😨':'страх fearful','😰':'тревога anxious','😥':'грустный disappointed','😢':'плачу crying','😭':'рыдаю loudly crying','😱':'ужас screaming fear','😖':'сбит с толку confounded','😣':'упорствую persevere','😞':'разочарован disappointed','😓':'холодный пот cold sweat','😩':'усталость weary','😫':'измотан tired','🥱':'зеваю yawning','😤':'злюсь huffing','😠':'злой angry','😡':'ярость rage','🤬':'брань symbols over mouth','😈':'злодей devil smiling','👿':'злой дьявол angry devil','💀':'череп skull','☠️':'кости skull crossbones','💩':'куча poop','🤡':'клоун clown','👋':'привет wave hello','✋':'стоп raised hand','👍':'лайк thumbs up like','👎':'дизлайк thumbs down dislike','👌':'окей ok','✌️':'мир peace victory','🤞':'удача fingers crossed','👏':'аплодисменты clapping','🙏':'пожалуйста please pray','💪':'сила muscle','❤️':'сердце heart love','🧡':'оранжевое сердце orange heart','💛':'жёлтое сердце yellow heart','💚':'зелёное сердце green heart','💙':'синее сердце blue heart','💜':'фиолетовое сердце purple heart','🖤':'чёрное сердце black heart','💔':'разбитое сердце broken heart','💕':'сердечки two hearts','💞':'вращающиеся сердца revolving hearts','💓':'бьющееся сердце beating heart','💗':'розовое сердце growing heart','💖':'искры сердце sparkling heart','🔥':'огонь fire','⭐':'звезда star','🌟':'сверкающая звезда glowing star','💫':'кружащаяся звезда dizzy star','✨':'искры sparkles','🎉':'конфетти party','🎊':'хлопушка confetti ball','🎈':'шарик balloon','🎁':'подарок gift','🏆':'кубок trophy','🥇':'золото gold medal first','🥈':'серебро silver medal','🥉':'бронза bronze medal','⚡':'молния lightning','❄️':'снег ice snow','🌈':'радуга rainbow','☀️':'солнце sun','🌙':'луна moon','🌊':'волна wave ocean','💧':'капля water drop','🌹':'роза rose','🌺':'цветок flower hibiscus','🌸':'сакура blossom','🌼':'ромашка daisy','🌻':'подсолнух sunflower','🍀':'клевер four leaf clover','🌲':'дерево tree','🌴':'пальма palm tree','🍕':'пицца pizza','🍔':'бургер burger','🍟':'картошка fries','🌭':'хот-дог hotdog','🍦':'мороженое ice cream','🍰':'торт cake','🎂':'день рождения birthday cake','🍫':'шоколад chocolate','🍬':'конфета candy','🍭':'леденец lollipop','☕':'кофе coffee','🍵':'чай tea','🍺':'пиво beer','🍻':'бокалы cheers beer','🥂':'шампанское champagne toast','🍷':'вино wine','🚗':'машина car','✈️':'самолёт airplane','🚀':'ракета rocket','🏠':'дом house home','💻':'ноутбук laptop computer','📱':'телефон phone mobile','📷':'фото camera','🎵':'музыка music note','🎶':'ноты notes music','🎮':'игры gaming controller','🎸':'гитара guitar','🎹':'пианино piano','⚽':'футбол soccer football','🏀':'баскетбол basketball','🎾':'теннис tennis','🐶':'собака dog','🐱':'кошка cat','🐭':'мышь mouse','🐰':'кролик rabbit','🐻':'медведь bear','🐼':'панда panda','🦁':'лев lion','🐯':'тигр tiger','🦊':'лиса fox','🐸':'лягушка frog','🐵':'обезьяна monkey','🦋':'бабочка butterfly','🐝':'пчела bee','🌸':'цветок sakura cherry blossom','👑':'корона crown king queen','💎':'алмаз diamond jewel','🔑':'ключ key','🎯':'цель target dart','💡':'лампочка idea light bulb','📚':'книги books','✏️':'карандаш pencil','📝':'заметка memo note','🔍':'поиск search magnify','🎭':'театр drama','🎨':'искусство art palette','🔒':'замок lock','🔓':'открытый замок unlock','🚫':'запрет no banned','✅':'галочка check','❌':'крест cross','❓':'вопрос question','❗':'восклицание exclamation','💯':'сто percent hundred','🤝':'рукопожатие handshake','🙌':'ура raising hands','🤲':'ладони open hands','🫂':'обнимаю hug','😺':'кот улыбка cat smile','😸':'кот смех cat laugh','😹':'кот слёзы cat tears','😻':'кот сердечки cat hearts','😼':'кот ухмылка cat smirk','😽':'кот поцелуй cat kiss','🙀':'кот ужас cat weary','😿':'кот плачет cat crying','😾':'кот злится cat pouting','🦄':'единорог unicorn','🐉':'дракон dragon','🦅':'орёл eagle','🦉':'сова owl','🐬':'дельфин dolphin','🦈':'акула shark','🦋':'бабочка butterfly','🌵':'кактус cactus','🍄':'гриб mushroom',
  };

  function searchEmoji(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) { _renderEmojiGridAll(); return; }
    const all = Object.values(_emojiData).flat();
    const filtered = all.filter(em => {
      const name = (_emojiNames[em] || em).toLowerCase();
      return name.includes(q);
    });
    _renderEmojiGrid(filtered, true);
  }

  function _insertEmoji(em) {
    const ta = getEl('message-input');
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const v = ta.value;
    ta.value = v.slice(0, s) + em + v.slice(e);
    ta.selectionStart = ta.selectionEnd = s + em.length;
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function toggleEmojiPicker() {
    const picker = getEl('emoji-picker');
    if (!picker) return;
    if (picker.style.display === 'none' || !picker.style.display) {
      _initEmojiPicker();
      picker.style.display = 'flex';
      // If twemoji wasn't loaded on init, re-render now that it may have loaded
      const grid = getEl('emoji-grid');
      if (grid && window.twemoji && !grid.querySelector('img.emoji')) {
        _renderEmojiGridAll();
      }
      // Фокус на поиск только на десктопе — на мобильных это открывает клавиатуру
      if (_isDesktop) {
        const searchEl = getEl('emoji-search');
        if (searchEl) setTimeout(() => searchEl.focus(), 50);
      }
    } else {
      picker.style.display = 'none';
    }
  }

  // ---- Панель настроек ----
  // ---- Открыть бургер-меню ----
  function toggleSettings() {
    const panel = getEl('burger-panel');
    const overlay = getEl('settings-overlay');
    const btn = getEl('settings-btn');
    if (!panel) return;
    isSettingsOpen = !isSettingsOpen;
    panel.classList.toggle('open', isSettingsOpen);
    if (overlay) overlay.classList.toggle('visible', isSettingsOpen);
    if (btn) btn.classList.toggle('is-open', isSettingsOpen);
    // Если закрываем — также закрываем все подстраницы
    if (!isSettingsOpen) {
      document.querySelectorAll('.menu-page.open').forEach(p => p.classList.remove('open'));
    }
  }

  function closeSettings() {
    closeMenu();
  }

  function closeMenu() {
    isSettingsOpen = false;
    const panel = getEl('burger-panel');
    const overlay = getEl('settings-overlay');
    const btn = getEl('settings-btn');
    if (panel) panel.classList.remove('open');
    if (overlay) overlay.classList.remove('visible');
    if (btn) btn.classList.remove('is-open');
    // Закрываем все подстраницы
    document.querySelectorAll('.menu-page.open').forEach(p => p.classList.remove('open'));
  }

  // ---- Открыть страницу меню (slide-in) ----
  function openMenuPage(pageId) {
    const page = getEl(pageId);
    if (!page) return;
    page.style.display = ''; // убираем display:none если было
    page.classList.add('open');
    // Загружаем данные при открытии нужной страницы
    if (pageId === 'page-contacts') renderContactsList();
    if (pageId === 'page-invites') loadInvitesList();
    if (pageId === 'page-sessions') loadSessionsList();
    if (pageId === 'page-security') { renderSecurityPage(); _updateE2eeStatusUI(); }
    if (pageId === 'page-sounds') _updateSoundSettingsUI();
  }

  function closeMenuPage(pageId) {
    const page = getEl(pageId);
    if (page) page.classList.remove('open');
  }

  function openSettingsSection(id) {}
  function closeSettingsSection() {}

  // ---- Анимации иконок бургер-меню ----
  const _burgerAnimMap = {
    '👥': 'anim-contacts',
    '📢': 'anim-channels',
    '👤': 'anim-account',
    '🔒': 'anim-security',
    '🎨': 'anim-appearance',
    '🔑': 'anim-invites',
    '🖥️': 'anim-sessions',
    '🔔': 'anim-bell',
  };

  function _initBurgerIconAnimations() {
    document.querySelectorAll('.burger-nav-item').forEach(btn => {
      // Анимация при наведении
      btn.addEventListener('mouseenter', () => {
        const iconEl = btn.querySelector('.burger-nav-icon');
        if (!iconEl) return;
        const emoji = iconEl.textContent.trim();
        const animClass = _burgerAnimMap[emoji];
        if (!animClass) return;
        iconEl.classList.remove(animClass);
        void iconEl.offsetWidth; // force reflow
        iconEl.classList.add(animClass);
        iconEl.addEventListener('animationend', () => {
          iconEl.classList.remove(animClass);
        }, { once: true });
      });
    });
  }

  // ---- Аккордеон-заглушка (больше не используется, но сохраняем для совместимости) ----
  function toggleSettingsGroup(groupId) {}

  // ---- Рендер профиля в меню ----
  function renderSettingsProfile() {
    // Карточка профиля в бургер-шапке
    const burgerProfile = getEl('burger-profile');
    if (burgerProfile && currentProfile) {
      const displayName = getDisplayName(currentProfile);
      burgerProfile.innerHTML = `
        ${getAvatarHTML(currentProfile, 44)}
        <div class="settings-user-info">
          <span class="settings-username" style="display:flex;align-items:center;gap:5px;">
            ${escapeHTML(displayName)}${getUserBadge(currentProfile)}
          </span>
          <span style="font-size:12px;color:var(--text-muted);">@${escapeHTML(currentProfile.username)}</span>
        </div>
      `;
    }

    // Карточка профиля на странице настроек
    const profileCard = getEl('settings-profile');
    if (profileCard && currentProfile) {
      const displayName = getDisplayName(currentProfile);
      profileCard.innerHTML = `
        ${getAvatarHTML(currentProfile, 52)}
        <div class="settings-user-info">
          <span class="settings-username" style="display:flex;align-items:center;gap:5px;">
            ${escapeHTML(displayName)}${getUserBadge(currentProfile)}
          </span>
          <span style="font-size:12px;color:var(--text-muted);">@${escapeHTML(currentProfile.username)}</span>
        </div>
      `;
    }

    // Аватар в блоке "Настройки"
    const avatarEl = getEl('settings-avatar-img');
    if (avatarEl && currentProfile) {
      avatarEl.innerHTML = getAvatarHTML(currentProfile, 72);
    }

    // Показываем/скрываем кнопку и страницу инвайтов только для разработчика
    const isDev = currentUser && currentUser.id === DEV_UID;
    const menuInvitesBtn = getEl('menu-invites-btn');
    if (menuInvitesBtn) menuInvitesBtn.style.display = isDev ? 'flex' : 'none';
    const pageInvites = getEl('page-invites');
    if (pageInvites) pageInvites.style.display = isDev ? 'flex' : 'none';
  }

  // ---- Изменение аватара ----
  function handleAvatarChange(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showToast('Можно загружать только изображения.', 'error');
      return;
    }

    if (file.size > MAX_AVATAR_SIZE) {
      showToast('Аватарка слишком большая. Максимум 5 МБ.', 'error');
      e.target.value = '';
      return;
    }

    e.target.value = '';

    // Открываем кроппер вместо прямой загрузки
    openAvatarCropper(file, async (blob) => {
      showToast('Загружаем аватар...', 'info');
      try {
        const filePath = `avatars/${currentUser.id}.jpg`;
        const { error: uploadError } = await window.supabaseClient.storage
          .from('chat-files')
          .upload(filePath, blob, { cacheControl: '3600', upsert: true, contentType: 'image/jpeg' });

        if (uploadError) {
          showToast('Ошибка загрузки аватара: ' + uploadError.message, 'error');
          return;
        }

        const { data: urlData } = window.supabaseClient.storage
          .from('chat-files')
          .getPublicUrl(filePath);

        const avatarUrl = urlData.publicUrl + '?t=' + Date.now();

        const { error: updateError } = await window.supabaseClient
          .from('profiles')
          .update({ avatar_url: avatarUrl })
          .eq('id', currentUser.id);

        if (updateError) {
          showToast('Ошибка обновления профиля: ' + updateError.message, 'error');
          return;
        }

        currentProfile.avatar_url = avatarUrl;
        renderSettingsProfile();
        showToast('Аватар обновлён!', 'success');
      } catch (err) {
        showToast('Непредвиденная ошибка', 'error');
        console.error('Ошибка аватара:', err);
      }
    });
  }

  // ---- Изменение отображаемого имени (display_name) ----
  // Это НЕ username (логин), а просто красивое имя, которое видят другие.
  // Может быть любым: с пробелами, кириллицей, эмодзи.
  async function handleDisplayNameChange() {
    const input = getEl('settings-displayname-input');
    const btn = getEl('settings-displayname-btn');
    if (!input || !btn) return;

    const newDisplayName = input.value.trim();

    if (!newDisplayName) {
      showToast('Введите новое имя.', 'error');
      return;
    }

    if (newDisplayName.length < 1) {
      showToast('Имя не может быть пустым.', 'error');
      return;
    }

    if (newDisplayName.length > 50) {
      showToast('Имя слишком длинное (макс. 50 символов).', 'error');
      return;
    }

    const currentDisplay = currentProfile.display_name || '';
    if (newDisplayName === currentDisplay) {
      showToast('Это уже ваше имя.', 'info');
      return;
    }

    btn.disabled = true;
    btn.textContent = '...';

    try {
      const { error } = await window.supabaseClient
        .from('profiles')
        .update({ display_name: newDisplayName })
        .eq('id', currentUser.id);

      if (error) {
        showToast('Ошибка: ' + error.message, 'error');
        return;
      }

      currentProfile.display_name = newDisplayName;
      input.value = '';
      renderSettingsProfile();
      showToast('Имя обновлено!', 'success');
    } catch (err) {
      showToast('Ошибка', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Сохранить';
    }
  }

  // ---- Смена пароля ----
  async function handlePasswordChange() {
    const newPwd  = (getEl('settings-new-password')?.value  || '').trim();
    const confPwd = (getEl('settings-conf-password')?.value || '').trim();
    const btn     = getEl('settings-password-btn');
    if (!btn) return;

    if (!newPwd) { showToast('Введите новый пароль.', 'error'); return; }
    if (newPwd.length < 6) { showToast('Пароль должен быть не менее 6 символов.', 'error'); return; }
    if (newPwd !== confPwd) { showToast('Пароли не совпадают.', 'error'); return; }

    btn.disabled = true;
    btn.textContent = '...';

    try {
      const { error } = await window.supabaseClient.auth.updateUser({ password: newPwd });
      if (error) { showToast('Ошибка: ' + error.message, 'error'); return; }
      if (getEl('settings-new-password'))  getEl('settings-new-password').value  = '';
      if (getEl('settings-conf-password')) getEl('settings-conf-password').value = '';
      showToast('Пароль изменён!', 'success');
    } catch (err) {
      showToast('Непредвиденная ошибка', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Изменить';
    }
  }

  // ---- Тема (Dark/Light) ----
  function setTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('messenger-theme', theme);

    // Обновляем активную кнопку (все кнопки с id вида theme-*-btn)
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    const activeBtn = getEl(`theme-${theme}-btn`);
    if (activeBtn) activeBtn.classList.add('active');

    // Обновляем meta theme-color для мобильного статус-бара и навигации
    const themeColors = {
      dark: '#080810',
      light: '#f0f2ff',
      ocean: '#eaf8fb',
      rose: '#fff0f3',
    };
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', themeColors[theme] || themeColors.dark);
  }

  function loadSavedTheme() {
    const saved = localStorage.getItem('messenger-theme') || 'dark';
    setTheme(saved);
  }

  // ---- Проверка версии приложения ----
  async function checkAppVersion() {
    try {
      const { data, error } = await window.supabaseClient
        .from('app_config')
        .select('value')
        .eq('key', 'min_version')
        .maybeSingle();
      if (error || !data) return; // таблицы нет или ошибка — тихо игнорируем
      const minVersion = data.value || '1.0.0';
      if (_versionOutdated(APP_VERSION, minVersion)) {
        _showUpdateBanner(minVersion);
      }
    } catch { /* таблица не существует — всё нормально */ }
  }

  function _versionOutdated(current, required) {
    const parse = v => v.split('.').map(Number);
    const [ca, cb, cc] = parse(current);
    const [ra, rb, rc] = parse(required);
    if (ca !== ra) return ca < ra;
    if (cb !== rb) return cb < rb;
    return cc < rc;
  }

  function _showUpdateBanner(newVersion) {
    const existing = document.getElementById('app-update-banner');
    if (existing) return;
    const banner = document.createElement('div');
    banner.id = 'app-update-banner';
    banner.className = 'app-update-banner';
    banner.innerHTML = `
      <div class="app-update-banner-inner">
        <div class="app-update-icon">🔄</div>
        <div class="app-update-text">
          <strong>Доступна версия ${newVersion} RELEASE</strong>
          <p>Ваша версия: ${APP_VERSION}. Обновите для корректной работы.</p>
        </div>
        <button class="app-update-btn" onclick="location.reload(true)">Обновить</button>
      </div>
    `;
    document.body.appendChild(banner);
  }

  // ---- Обои чата ----
  const wallpapers = [
    { id: 'none',     label: 'Нет',        style: 'background: none;' },
    { id: 'dots',     label: 'Точки',      style: 'background-color: var(--chat-bg); background-image: radial-gradient(circle, rgba(var(--accent-rgb,108,99,255),0.35) 1.5px, transparent 1.5px); background-size: 22px 22px;' },
    { id: 'grid',     label: 'Сетка',      style: 'background-color: var(--chat-bg); background-image: linear-gradient(rgba(var(--accent-rgb,108,99,255),0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(var(--accent-rgb,108,99,255),0.12) 1px, transparent 1px); background-size: 32px 32px;' },
    { id: 'diagonal', label: 'Диагональ',  style: 'background-color: var(--chat-bg); background-image: repeating-linear-gradient(45deg, rgba(var(--accent-rgb,108,99,255),0.08) 0px, rgba(var(--accent-rgb,108,99,255),0.08) 1px, transparent 1px, transparent 12px);' },
    { id: 'waves',    label: 'Волны',      style: 'background-color: var(--chat-bg); background-image: repeating-radial-gradient(circle at 0 50%, transparent 9px, rgba(var(--accent-rgb,108,99,255),0.1) 10px, transparent 11px);  background-size: 20px 20px;' },
    { id: 'circles',  label: 'Круги',      style: 'background-color: var(--chat-bg); background-image: radial-gradient(circle, transparent 14px, rgba(var(--accent-rgb,108,99,255),0.12) 15px, rgba(var(--accent-rgb,108,99,255),0.12) 16px, transparent 17px); background-size: 40px 40px;' },
    { id: 'cross',    label: 'Крестики',   style: 'background-color: var(--chat-bg); background-image: linear-gradient(rgba(var(--accent-rgb,108,99,255),0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(var(--accent-rgb,108,99,255),0.14) 1px, transparent 1px); background-size: 16px 16px; background-position: center center;' },
    { id: 'zigzag',   label: 'Зигзаг',    style: 'background-color: var(--chat-bg); background-image: linear-gradient(135deg, rgba(var(--accent-rgb,108,99,255),0.10) 25%, transparent 25%), linear-gradient(225deg, rgba(var(--accent-rgb,108,99,255),0.10) 25%, transparent 25%), linear-gradient(315deg, rgba(var(--accent-rgb,108,99,255),0.10) 25%, transparent 25%), linear-gradient(45deg, rgba(var(--accent-rgb,108,99,255),0.10) 25%, transparent 25%); background-size: 16px 16px;' },
    { id: 'hex',      label: 'Соты',       style: 'background-color: var(--chat-bg); background-image: radial-gradient(circle farthest-side at 0% 50%, rgba(var(--accent-rgb,108,99,255),0.0) 23.5%, rgba(var(--accent-rgb,108,99,255),0.10) 25%, rgba(var(--accent-rgb,108,99,255),0.10) 26%, rgba(var(--accent-rgb,108,99,255),0.0) 27.5%), radial-gradient(circle farthest-side at 0% 50%, rgba(var(--accent-rgb,108,99,255),0.0) 23.5%, rgba(var(--accent-rgb,108,99,255),0.10) 25%, rgba(var(--accent-rgb,108,99,255),0.10) 26%, rgba(var(--accent-rgb,108,99,255),0.0) 27.5%); background-size: 34px 60px;' },
    { id: 'bubbles',  label: 'Пузыри',     style: 'background-color: var(--chat-bg); background-image: radial-gradient(circle at 20% 35%, rgba(var(--accent-rgb,108,99,255),0.12) 10px, transparent 10px), radial-gradient(circle at 75% 44%, rgba(var(--accent-rgb,108,99,255),0.09) 7px, transparent 7px), radial-gradient(circle at 55% 80%, rgba(var(--accent-rgb,108,99,255),0.10) 5px, transparent 5px); background-size: 80px 80px;' },
    { id: 'stripe',   label: 'Полосы',     style: 'background-color: var(--chat-bg); background-image: repeating-linear-gradient(90deg, rgba(var(--accent-rgb,108,99,255),0.06) 0px, rgba(var(--accent-rgb,108,99,255),0.06) 1px, transparent 1px, transparent 24px);' },
    { id: 'noise',    label: 'Зернистость', style: 'background-color: var(--chat-bg); background-image: url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\' opacity=\'0.05\'/%3E%3C/svg%3E"); background-size: 150px 150px;' },
    { id: 'aurora',   label: 'Аврора',     style: 'background: linear-gradient(160deg, rgba(34,197,94,0.18) 0%, rgba(6,182,212,0.14) 35%, rgba(168,85,247,0.18) 70%, rgba(249,115,22,0.12) 100%), var(--chat-bg);' },
    { id: 'sunset-bg',label: 'Закат',      style: 'background: linear-gradient(180deg, rgba(249,115,22,0.20) 0%, rgba(239,68,68,0.15) 40%, rgba(168,85,247,0.18) 80%, rgba(30,144,255,0.12) 100%), var(--chat-bg);' },
    { id: 'ocean-bg', label: 'Океан',      style: 'background: linear-gradient(160deg, rgba(6,182,212,0.20) 0%, rgba(14,165,233,0.14) 50%, rgba(13,148,136,0.16) 100%), var(--chat-bg);' },
    { id: 'rose-bg',  label: 'Розовый',    style: 'background: linear-gradient(135deg, rgba(244,63,94,0.18) 0%, rgba(236,72,153,0.14) 50%, rgba(251,113,133,0.12) 100%), var(--chat-bg);' },
    { id: 'forest-bg',label: 'Лесной',     style: 'background: linear-gradient(160deg, rgba(22,163,74,0.18) 0%, rgba(34,197,94,0.12) 50%, rgba(13,148,136,0.15) 100%), var(--chat-bg);' },
    { id: 'galaxy',   label: 'Галактика',  style: 'background: radial-gradient(ellipse at 30% 40%, rgba(168,85,247,0.25) 0%, transparent 60%), radial-gradient(ellipse at 70% 60%, rgba(30,144,255,0.22) 0%, transparent 55%), radial-gradient(ellipse at 50% 80%, rgba(236,72,153,0.18) 0%, transparent 50%), var(--chat-bg); background-image: radial-gradient(circle, rgba(255,255,255,0.5) 1px, transparent 1px), radial-gradient(ellipse at 30% 40%, rgba(168,85,247,0.25) 0%, transparent 60%), radial-gradient(ellipse at 70% 60%, rgba(30,144,255,0.22) 0%, transparent 55%); background-size: 40px 40px, 100% 100%, 100% 100%;' },
    { id: 'stars',    label: 'Звёзды',     style: 'background-color: var(--chat-bg); background-image: radial-gradient(circle, rgba(255,255,255,0.55) 1px, transparent 1px), radial-gradient(circle, rgba(255,255,255,0.30) 1px, transparent 1px); background-size: 60px 60px, 30px 30px; background-position: 0 0, 15px 15px;' },
    { id: 'triangles',label: 'Треугольники', style: 'background-color: var(--chat-bg); background-image: linear-gradient(60deg, rgba(var(--accent-rgb,108,99,255),0.10) 25%, transparent 25%), linear-gradient(120deg, rgba(var(--accent-rgb,108,99,255),0.10) 25%, transparent 25%), linear-gradient(60deg, transparent 75%, rgba(var(--accent-rgb,108,99,255),0.10) 75%), linear-gradient(120deg, transparent 75%, rgba(var(--accent-rgb,108,99,255),0.10) 75%); background-size: 30px 52px;' },
    { id: 'mosaic',   label: 'Мозаика',    style: 'background-color: var(--chat-bg); background-image: linear-gradient(45deg, rgba(var(--accent-rgb,108,99,255),0.08) 25%, transparent 25%), linear-gradient(-45deg, rgba(var(--accent-rgb,108,99,255),0.08) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(var(--accent-rgb,108,99,255),0.08) 75%), linear-gradient(-45deg, transparent 75%, rgba(var(--accent-rgb,108,99,255),0.08) 75%); background-size: 20px 20px;' },
  ];

  function renderWallpaperPicker() {
    const container = getEl('wallpaper-picker');
    if (!container) return;

    container.innerHTML = wallpapers.map((w) => {
      const isActive = currentWallpaper === w.id;
      return `
        <div class="wallpaper-option ${isActive ? 'active' : ''}"
             title="${w.label}"
             onclick="Chat.setWallpaper('${w.id}')">
          <span class="wallpaper-label">${w.label}</span>
        </div>
      `;
    }).join('');
  }

  function setWallpaper(wallpaperId) {
    currentWallpaper = wallpaperId;
    localStorage.setItem('messenger-wallpaper', wallpaperId);

    const chatBg = getEl('chat-background');
    const wall = wallpapers.find((w) => w.id === wallpaperId);
    if (chatBg && wall) {
      chatBg.setAttribute('style', wall.style + ' position: absolute; inset: 0; z-index: 0;');
      chatBg.className = 'chat-bg-layer';
    }

    renderWallpaperPicker();
  }

  function loadSavedWallpaper() {
    const saved = localStorage.getItem('messenger-wallpaper') || 'none';
    setWallpaper(saved);
  }

  // ============================================================
  // ---- Кастомные обои чата (локально) ----
  // ============================================================
  let _customWallpaperDataUrl = localStorage.getItem('iflash_custom_wallpaper') || null;

  function pickCustomWallpaper() {
    const input = document.getElementById('custom-wallpaper-input');
    if (input) input.click();
  }

  function applyCustomWallpaper(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      _customWallpaperDataUrl = e.target.result;
      localStorage.setItem('iflash_custom_wallpaper', _customWallpaperDataUrl);
      _applyCustomWallpaperToDOM(_customWallpaperDataUrl);
      const clearBtn = document.getElementById('clear-wallpaper-btn');
      if (clearBtn) clearBtn.style.display = '';
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }

  function _applyCustomWallpaperToDOM(dataUrl) {
    const chatBg = getEl('chat-background');
    if (!chatBg) return;
    chatBg.setAttribute('style', `background-image: url('${dataUrl}'); background-size: cover; background-position: center; position: absolute; inset: 0; z-index: 0;`);
    chatBg.className = 'chat-bg-layer';
  }

  function clearCustomWallpaper() {
    _customWallpaperDataUrl = null;
    localStorage.removeItem('iflash_custom_wallpaper');
    const clearBtn = document.getElementById('clear-wallpaper-btn');
    if (clearBtn) clearBtn.style.display = 'none';
    // Восстанавливаем текущую пресет-обои
    loadSavedWallpaper();
  }

  function _loadCustomWallpaper() {
    if (_customWallpaperDataUrl) {
      _applyCustomWallpaperToDOM(_customWallpaperDataUrl);
      const clearBtn = document.getElementById('clear-wallpaper-btn');
      if (clearBtn) clearBtn.style.display = '';
    }
  }

  // ============================================================
  // ---- Кастомные звуки (локально, IndexedDB/localStorage) ----
  // ============================================================
  // Хранить сам файл в localStorage через dataURL (base64)
  let _customNotifSoundDataUrl = null;
  let _customRingSoundDataUrl = null;

  function _loadCustomSounds() {
    try {
      _customNotifSoundDataUrl = localStorage.getItem('iflash_custom_notif_sound') || null;
      _customRingSoundDataUrl = localStorage.getItem('iflash_custom_ring_sound') || null;
    } catch {}
    _updateSoundSettingsUI();
  }

  function _updateSoundSettingsUI() {
    const notifName = document.getElementById('notif-sound-name');
    const notifResetBtn = document.getElementById('reset-notif-btn');
    const ringName = document.getElementById('ring-sound-name');
    const ringResetBtn = document.getElementById('reset-ring-btn');
    if (notifName) notifName.textContent = _customNotifSoundDataUrl ? 'Кастомный звук' : 'По умолчанию (yvedomlenia.MP3)';
    if (notifResetBtn) notifResetBtn.style.display = _customNotifSoundDataUrl ? '' : 'none';
    if (ringName) ringName.textContent = _customRingSoundDataUrl ? 'Кастомный звук' : 'По умолчанию (zvonok.mp3)';
    if (ringResetBtn) ringResetBtn.style.display = _customRingSoundDataUrl ? '' : 'none';
  }

  function applyCustomNotifSound(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Файл звука > 5 МБ', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      _customNotifSoundDataUrl = e.target.result;
      try { localStorage.setItem('iflash_custom_notif_sound', _customNotifSoundDataUrl); } catch { showToast('Файл слишком большой для хранения', 'error'); _customNotifSoundDataUrl = null; }
      _notifAudio = null; // сбросить кэш аудио
      _updateSoundSettingsUI();
      showToast('Звук уведомлений изменён', 'success');
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }

  let _previewNotifAudio = null;
  function previewNotifSound() {
    const btn = document.querySelector('#page-sounds [onclick="Chat.previewNotifSound()"]');
    if (_previewNotifAudio && !_previewNotifAudio.paused) {
      _previewNotifAudio.pause();
      _previewNotifAudio.currentTime = 0;
      _previewNotifAudio = null;
      if (btn) btn.textContent = '▶ Прослушать';
      return;
    }
    try {
      const src = _customNotifSoundDataUrl || 'yvedomlenia.MP3';
      const a = new Audio(src);
      _previewNotifAudio = a;
      a.volume = 0.6;
      if (btn) btn.textContent = '■ Остановить';
      a.addEventListener('ended', () => { _previewNotifAudio = null; if (btn) btn.textContent = '▶ Прослушать'; });
      a.play().catch(() => {});
    } catch {}
  }

  function resetNotifSound() {
    _customNotifSoundDataUrl = null;
    localStorage.removeItem('iflash_custom_notif_sound');
    _notifAudio = null;
    _updateSoundSettingsUI();
    showToast('Звук уведомлений сброшен', 'success');
  }

  function applyCustomRingSound(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Файл звука > 5 МБ', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      _customRingSoundDataUrl = e.target.result;
      try { localStorage.setItem('iflash_custom_ring_sound', _customRingSoundDataUrl); } catch { showToast('Файл слишком большой для хранения', 'error'); _customRingSoundDataUrl = null; }
      _updateSoundSettingsUI();
      showToast('Мелодия звонка изменена', 'success');
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }

  let _previewRingAudio = null;
  function previewRingSound() {
    const btn = document.querySelector('#page-sounds [onclick="Chat.previewRingSound()"]');
    if (_previewRingAudio && !_previewRingAudio.paused) {
      _previewRingAudio.pause();
      _previewRingAudio.currentTime = 0;
      _previewRingAudio = null;
      if (btn) btn.textContent = '▶ Прослушать';
      return;
    }
    try {
      const src = _customRingSoundDataUrl || 'zvonok.mp3';
      const a = new Audio(src);
      _previewRingAudio = a;
      a.volume = 0.6;
      if (btn) btn.textContent = '■ Остановить';
      a.addEventListener('ended', () => { _previewRingAudio = null; if (btn) btn.textContent = '▶ Прослушать'; });
      a.play().catch(() => {});
    } catch {}
  }

  function resetRingSound() {
    _customRingSoundDataUrl = null;
    localStorage.removeItem('iflash_custom_ring_sound');
    _updateSoundSettingsUI();
    showToast('Мелодия звонка сброшена', 'success');
  }

  // ============================================================
  // ---- Гудки вызова (встроенные, Web Audio API) ----
  // ============================================================
  let _callBeepCtx = null;
  let _callBeepInterval = null;

  function _startCallBeeps() {
    _stopCallBeeps();
    try {
      _callBeepCtx = new (window.AudioContext || window.webkitAudioContext)();
      let beat = 0;
      function playBeep() {
        if (!_callBeepCtx) return;
        const osc = _callBeepCtx.createOscillator();
        const gain = _callBeepCtx.createGain();
        osc.connect(gain);
        gain.connect(_callBeepCtx.destination);
        osc.type = 'sine';
        osc.frequency.value = 440;
        gain.gain.setValueAtTime(0.22, _callBeepCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, _callBeepCtx.currentTime + 0.35);
        osc.start(_callBeepCtx.currentTime);
        osc.stop(_callBeepCtx.currentTime + 0.36);
      }
      playBeep();
      // Гудок: 0.4с сигнал, 0.6с пауза → период 1с
      _callBeepInterval = setInterval(playBeep, 1000);
    } catch {}
  }

  function _stopCallBeeps() {
    if (_callBeepInterval) { clearInterval(_callBeepInterval); _callBeepInterval = null; }
    if (_callBeepCtx) { try { _callBeepCtx.close(); } catch {} _callBeepCtx = null; }
  }

  // ---- Звук уведомления ----
  let _notifAudio = null;
  function _playNotificationSound() {
    try {
      const src = _customNotifSoundDataUrl || 'yvedomlenia.MP3';
      if (!_notifAudio || _notifAudio._src !== src) {
        _notifAudio = new Audio(src);
        _notifAudio._src = src;
        _notifAudio.volume = 0.5;
      }
      _notifAudio.currentTime = 0;
      _notifAudio.play().catch(() => {});
    } catch {}
  }

  // ---- Звук звонка ----
  let _ringAudio = null;
  let _ringAudioPlaying = false;
  function _startRingSound() {
    try {
      const src = _customRingSoundDataUrl || 'zvonok.mp3';
      if (!_ringAudio || _ringAudio._src !== src) {
        _ringAudio = new Audio(src);
        _ringAudio._src = src;
        _ringAudio.loop = true;
        _ringAudio.volume = 0.7;
      }
      _ringAudio.currentTime = 0;
      _ringAudio.play().catch(() => {});
      _ringAudioPlaying = true;
    } catch {}
  }
  function _stopRingSound() {
    if (_ringAudio && _ringAudioPlaying) {
      _ringAudio.pause();
      _ringAudio.currentTime = 0;
      _ringAudioPlaying = false;
    }
  }

  // ---- Toast-уведомления ----
  function showToast(message, type = 'info', onClick = null) {
    const container = getEl('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = { success: '✓', error: '✕', info: 'ℹ', message: '💬' };
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || 'ℹ'}</span>
      <span class="toast-text">${escapeHTML(message)}</span>
    `;

    if (onClick) {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => {
        onClick();
        toast.remove();
      });
    }

    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('visible'));

    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // ================================================================
  //  VOICE MESSAGE PLAYBACK IN CHAT
  // ================================================================
  function toggleMsgVoice(uid) {
    const audio = getEl(`${uid}-audio`);
    const icon = getEl(`${uid}-icon`);
    if (!audio) return;
    // Pause all other audio
    document.querySelectorAll('audio').forEach(a => {
      if (a !== audio && !a.paused) {
        a.pause();
        const otherId = a.id.replace('-audio', '');
        const otherIcon = getEl(`${otherId}-icon`);
        if (otherIcon) otherIcon.innerHTML = '<polygon points="5,3 19,12 5,21"/>';
      }
    });
    if (audio.paused) {
      audio.play();
      if (icon) icon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
      audio.pause();
      if (icon) icon.innerHTML = '<polygon points="5,3 19,12 5,21"/>';
    }
  }

  function seekMsgVoice(uid) {
    const audio = getEl(`${uid}-audio`);
    const seekEl = getEl(`${uid}-seek`);
    if (audio && audio.duration && seekEl) {
      audio.currentTime = (seekEl.value / 100) * audio.duration;
    }
  }

  function onVoiceMetaLoaded(uid) {
    const audio = getEl(`${uid}-audio`);
    const durEl = getEl(`${uid}-dur`);
    if (audio && durEl && audio.duration && isFinite(audio.duration)) {
      const d = Math.floor(audio.duration);
      durEl.textContent = `${Math.floor(d/60)}:${(d%60).toString().padStart(2,'0')}`;
    }
  }

  // ---- Vidnote metadata loaded (показываем длительность) ----
  function onVidnoteMetaLoaded(uid) {
    const video = getEl(`${uid}-video`);
    const durEl = getEl(`${uid}-dur`);
    if (video && durEl && video.duration && isFinite(video.duration)) {
      const d = Math.floor(video.duration);
      durEl.textContent = `Кружок ${Math.floor(d/60)}:${(d%60).toString().padStart(2,'0')}`;
    }
  }

  function onVoiceTimeUpdate(uid) {
    const audio = getEl(`${uid}-audio`);
    const seekEl = getEl(`${uid}-seek`);
    const fillEl = getEl(`${uid}-fill`);
    const durEl = getEl(`${uid}-dur`);
    if (!audio || !audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    if (seekEl) seekEl.value = pct;
    if (fillEl) fillEl.style.width = pct + '%';
    const rem = Math.floor(audio.duration - audio.currentTime);
    if (durEl) durEl.textContent = `${Math.floor(rem/60)}:${(rem%60).toString().padStart(2,'0')}`;
  }

  function onVoiceEnded(uid) {
    const icon = getEl(`${uid}-icon`);
    const seekEl = getEl(`${uid}-seek`);
    const fillEl = getEl(`${uid}-fill`);
    const audio = getEl(`${uid}-audio`);
    if (icon) icon.innerHTML = '<polygon points="5,3 19,12 5,21"/>';
    if (seekEl) seekEl.value = 0;
    if (fillEl) fillEl.style.width = '0%';
    if (audio && audio.duration && isFinite(audio.duration)) {
      const d = Math.floor(audio.duration);
      const durEl = getEl(`${uid}-dur`);
      if (durEl) durEl.textContent = `${Math.floor(d/60)}:${(d%60).toString().padStart(2,'0')}`;
    }
  }

  // ---- Возврат к списку (мобильные) ----
  function goBackToList() {
    const sidebar = document.querySelector('.sidebar');
    const mainChat = document.querySelector('.main-chat');
    if (sidebar) sidebar.classList.remove('hidden-mobile');
    if (mainChat) mainChat.classList.remove('visible-mobile');
  }

  // ---- Escape HTML ----
  function escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ---- Escape + кликабельные ссылки (http/https/ftp) ----
  function linkifyText(rawText) {
    if (!rawText) return '';
    // Разбиваем по URL-паттерну с захватывающей группой — нечётные индексы = URL
    const urlPattern = /(https?:\/\/[^\s<>"'()[\]{}]+)/gi;
    const parts = rawText.split(urlPattern);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        // Часть совпала с URL
        const escapedUrl = escapeHTML(part);
        return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" class="msg-link">${escapedUrl}</a>`;
      }
      return escapeHTML(part);
    }).join('');
  }

  // ---- Сворачиваемый длинный текст ----
  const MSG_COLLAPSE_LIMIT = 600; // символов — если больше, сворачиваем
  const MSG_COLLAPSE_PREVIEW = 500; // сколько показывать в свёрнутом виде

  function _renderLongText(text, uid) {
    if (!text || text.length <= MSG_COLLAPSE_LIMIT) {
      return `<p class="msg-text">${_applyTextFormatting(linkifyText(text))}</p>`;
    }
    const preview = text.slice(0, MSG_COLLAPSE_PREVIEW);
    const rest = text.slice(MSG_COLLAPSE_PREVIEW);
    const previewLinked = _applyTextFormatting(linkifyText(preview));
    const restLinked = _applyTextFormatting(linkifyText(rest));
    const spanId = `collapse-${uid || Math.random().toString(36).slice(2)}`;
    return `<p class="msg-text">
      <span class="msg-text-preview">${previewLinked}<span class="msg-text-ellipsis">...</span></span>
      <span class="msg-text-rest" id="${spanId}" style="display:none;">${restLinked}</span>
      <br><button class="msg-collapse-btn" onclick="Chat._toggleMsgCollapse('${spanId}',this)">Развернуть</button>
    </p>`;
  }

  // Применяет форматирование к уже HTML-escaped тексту (после linkifyText)
  function _applyTextFormatting(html) {
    if (!html) return html;
    // Не трогаем содержимое <a> тегов
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/__(.+?)__/g, '<u>$1</u>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    html = html.replace(/`(.+?)`/g, '<code class="msg-mono">$1</code>');
    html = html.replace(/\|\|(.+?)\|\|/g, '<span class="msg-spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');
    html = html.replace(/(^|\n)&gt;\s?(.+)/g, '$1<blockquote class="msg-blockquote">$2</blockquote>');
    return html;
  }

  function _toggleMsgCollapse(spanId, btn) {
    const span = document.getElementById(spanId);
    const preview = btn.closest('p')?.querySelector('.msg-text-preview');
    const ellipsis = btn.closest('p')?.querySelector('.msg-text-ellipsis');
    if (!span) return;
    const collapsed = span.style.display === 'none';
    span.style.display = collapsed ? 'inline' : 'none';
    if (preview) preview.style.opacity = collapsed ? '1' : '';
    if (ellipsis) ellipsis.style.display = collapsed ? 'none' : 'inline';
    btn.textContent = collapsed ? 'Свернуть' : 'Развернуть';
  }

  // ============================================================
  //  ФОРМАТИРОВАНИЕ ТЕКСТА
  // ============================================================

  // Парсер форматирования: **bold**, *italic*, __underline__, ~~strike~~, `mono`, ||spoiler||, > quote
  function formatMessageText(text) {
    if (!text) return text;
    let html = escapeHTML(text);
    // Порядок важен: сначала многосимвольные маркеры
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/__(.+?)__/g, '<u>$1</u>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    html = html.replace(/`(.+?)`/g, '<code class="msg-mono">$1</code>');
    html = html.replace(/\|\|(.+?)\|\|/g, '<span class="msg-spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');
    // Цитата (строки начинающиеся с >)
    html = html.replace(/(^|\n)&gt;\s?(.+)/g, '$1<blockquote class="msg-blockquote">$2</blockquote>');
    return html;
  }

  // Контекстное меню форматирования для поля ввода
  function showInputFormatMenu(e) {
    const input = getEl('message-input');
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === end) return; // нет выделения — не показываем

    e.preventDefault();
    document.querySelectorAll('.input-format-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'msg-context-menu input-format-menu';
    menu.innerHTML = `
      <button class="msg-ctx-item" data-wrap="**">𝐁 Жирный</button>
      <button class="msg-ctx-item" data-wrap="*">𝐼 Курсив</button>
      <button class="msg-ctx-item" data-wrap="__">U Подчёркнутый</button>
      <button class="msg-ctx-item" data-wrap="~~">S̶ Зачёркнутый</button>
      <button class="msg-ctx-item" data-wrap="&gt; " data-prefix="true">❝ Цитата</button>
      <button class="msg-ctx-item" data-wrap="\`">⌨ Моноширинный</button>
      <button class="msg-ctx-item" data-wrap="||">👁 Скрытый</button>
    `;
    document.body.appendChild(menu);

    menu.querySelectorAll('[data-wrap]').forEach(btn => {
      btn.addEventListener('click', () => {
        const wrap = btn.dataset.wrap;
        const selected = input.value.substring(start, end);
        let newText;
        if (btn.dataset.prefix) {
          // Цитата: добавляем > в начало каждой строки
          newText = input.value.substring(0, start) + selected.split('\n').map(l => '> ' + l).join('\n') + input.value.substring(end);
        } else {
          newText = input.value.substring(0, start) + wrap + selected + wrap + input.value.substring(end);
        }
        input.value = newText;
        input.focus();
        // Ставим курсор после форматированного текста
        const newPos = btn.dataset.prefix
          ? start + selected.split('\n').map(l => '> ' + l).join('\n').length
          : end + wrap.length * 2;
        input.setSelectionRange(newPos, newPos);
        menu.remove();
        // Обновляем высоту ввода
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        updateSendBtnVisibility();
      });
    });

    let x = e.clientX, y = e.clientY;
    menu.style.left = '0'; menu.style.top = '-9999px';
    requestAnimationFrame(() => {
      const mh = menu.offsetHeight, mw = menu.offsetWidth;
      const vw = window.innerWidth, vh = window.innerHeight;
      if (x + mw > vw) x = vw - mw - 8;
      if (x < 8) x = 8;
      if (y - mh > 0) y = y - mh - 4; else if (y + mh > vh) y = vh - mh - 8;
      menu.style.left = x + 'px'; menu.style.top = y + 'px';
    });

    const close = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); document.removeEventListener('touchstart', close); }
    };
    setTimeout(() => { document.addEventListener('click', close); document.addEventListener('touchstart', close); }, 50);
  }

  // ============================================================
  //  СИСТЕМА ОТВЕТА НА СООБЩЕНИЕ (REPLY)
  // ============================================================

  let _replyTo = null; // { msgId, senderName, senderAvatar, text, quoteText }

  function startReply(msgId, senderName, senderAvatar, text) {
    _replyTo = { msgId, senderName, senderAvatar: senderAvatar || null, text: text || '', quoteText: null };
    _showReplyBanner();
    const input = getEl('message-input');
    if (input) input.focus();
  }

  function startReplyWithQuote(msgId, senderName, senderAvatar, quoteText) {
    _replyTo = { msgId, senderName, senderAvatar: senderAvatar || null, text: '', quoteText: quoteText || '' };
    _showReplyBanner();
    const input = getEl('message-input');
    if (input) input.focus();
  }

  function cancelReply() {
    _replyTo = null;
    const banner = getEl('reply-banner');
    if (banner) banner.style.display = 'none';
  }

  function _showReplyBanner() {
    const banner = getEl('reply-banner');
    if (!banner || !_replyTo) return;
    banner.style.display = 'flex';

    const isQuote = !!_replyTo.quoteText;
    const displayText = isQuote ? _replyTo.quoteText : _replyTo.text;
    const truncated = displayText.length > 30 ? displayText.slice(0, 30) + '…' : displayText;
    const avatarHTML = _replyTo.senderAvatar
      ? `<img src="${_replyTo.senderAvatar}" class="reply-banner-avatar" alt="">`
      : '';

    banner.innerHTML = `
      <div class="reply-banner-line"></div>
      <div class="reply-banner-content">
        <div class="reply-banner-header">
          ${avatarHTML}
          <span class="reply-banner-name">${isQuote ? '❝ Цитата' : escapeHTML(_replyTo.senderName || '')}</span>
        </div>
        <div class="reply-banner-text">${escapeHTML(truncated)}</div>
      </div>
      <button class="reply-banner-close" onclick="Chat.cancelReply()" title="Отменить">✕</button>
    `;
  }

  function _getReplyData() {
    if (!_replyTo) return null;
    return {
      reply_to: _replyTo.msgId,
      reply_text: (_replyTo.quoteText || _replyTo.text || '').slice(0, 100),
      quote_text: _replyTo.quoteText || null
    };
  }

  // ---- Отрисовка плашки ответа в пузыре сообщения ----
  function _buildReplyPlateHTML(msg) {
    if (!msg.reply_to) return '';
    const replyText = msg.reply_text || '';
    const quoteText = msg.quote_text || '';
    const truncated = (quoteText || replyText).length > 50
      ? (quoteText || replyText).slice(0, 50) + '…'
      : (quoteText || replyText);
    const isQuote = !!quoteText;
    return `
      <div class="reply-plate ${isQuote ? 'reply-plate-quote' : ''}" data-reply-id="${escapeHTML(msg.reply_to)}" onclick="Chat.scrollToMessage('${escapeHTML(msg.reply_to)}', ${isQuote ? `'${escapeHTML(quoteText).replace(/'/g, "\\'")}'` : 'null'})">
        <div class="reply-plate-line"></div>
        <div class="reply-plate-content">
          <span class="reply-plate-label">${isQuote ? '❝ Цитата' : '↩ Ответ'}</span>
          <span class="reply-plate-text">${escapeHTML(truncated)}</span>
        </div>
      </div>
    `;
  }

  // Прокрутка к сообщению и подсветка
  function scrollToMessage(msgId, highlightQuoteText) {
    const target = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('msg-highlight');
    setTimeout(() => target.classList.remove('msg-highlight'), 2000);

    // Если есть цитата — подсветить текст цитаты в сообщении
    if (highlightQuoteText) {
      setTimeout(() => {
        const textEl = target.querySelector('.msg-text');
        if (textEl) {
          const originalHTML = textEl.innerHTML;
          const escaped = escapeHTML(highlightQuoteText);
          // Пытаемся найти текст и подсветить
          if (textEl.textContent.includes(highlightQuoteText)) {
            const range = document.createRange();
            const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const idx = node.textContent.indexOf(highlightQuoteText);
              if (idx >= 0) {
                range.setStart(node, idx);
                range.setEnd(node, idx + highlightQuoteText.length);
                const highlight = document.createElement('mark');
                highlight.className = 'quote-highlight';
                range.surroundContents(highlight);
                setTimeout(() => {
                  highlight.replaceWith(...highlight.childNodes);
                }, 2500);
                break;
              }
            }
          }
        }
      }, 400);
    }
  }

  // ---- Инициализация ----
  async function init(user) {
    _initGeneration++;
    const _myInitGen = _initGeneration;
    currentUser = user;

    // Кэшируем токен авторизации для _setOffline
    _refreshCachedToken();
    // Обновляем токен каждые 5 минут (сохраняем ID чтобы очистить при logout)
    if (_tokenRefreshInterval) clearInterval(_tokenRefreshInterval);
    _tokenRefreshInterval = setInterval(_refreshCachedToken, 5 * 60 * 1000);

    // Загрузка профиля — если нет, значит аккаунт удалён из БД
    const profile = await loadCurrentProfile(user.id);
    if (!profile) {
      // Профиль не найден — принудительный выход, не давая войти
      console.warn('[App] Профиль не найден в БД — принудительный выход');
      await window.supabaseClient.auth.signOut();
      currentUser = null;
      window.App && window.App.onLogout();
      return;
    }

    await loadAllProfiles();

    // Загружаем блокировки
    await loadBlockedUsers();

    // Загружаем кастомные имена/аватарки контактов
    loadContactOverrides();

    // Загружаем настройки приватности
    loadPrivacySettings();

    // Проверяем версию приложения
    checkAppVersion();

    // Синхронизируем контакты с сервером
    await syncContactsWithServer();

    // Загружаем группы
    await loadGroups();

    // Загружаем каналы
    if (window.Channels) {
      await window.Channels.loadChannels();
      // Загружаем счётчики непрочитанных для групп и каналов (в фоне)
      _loadGroupUnreadCounts().then(() => {
        const convList = getEl('conversations-list');
        if (convList) renderGroupsInList(convList);
      });
      if (window.Channels._loadChannelUnreadCounts) {
        window.Channels._loadChannelUnreadCounts().then(() => {
          const convList = getEl('conversations-list');
          if (convList) window.Channels.renderChannelsInList(convList);
        });
      }
    }

    // ── E2EE: инициализация ключевой пары (один ключ на аккаунт, не на устройство) ──
    if (window.Encryption) {
      try {
        await window.Encryption.initUser(currentUser.id);
        _updateE2eeStatusUI();
        // Если есть видимые зашифрованные сообщения — перерасшифровываем
        if (window.Encryption.reDecryptVisible) {
          window.Encryption.reDecryptVisible().catch(() => {});
        }
      } catch (e) {
        console.error('[E2EE] initUser failed:', e.message);
        _updateE2eeStatusUI(false);
      }
    }

    // Настройки из localStorage — проверяем, что пользователь не вышел пока грузились данные
    if (_initGeneration !== _myInitGen) return;
    loadSavedTheme();
    loadSavedWallpaper();
    _loadCustomWallpaper();  // кастомное фото поверх пресета
    _loadCustomSounds();     // кастомные звуки
    renderWallpaperPicker();

    // Диалоги
    loadConversations();

    // Realtime
    subscribeToMessages();
    subscribeToReactions();
    _startReactionsPolling();
    subscribeToGroupUpdates();
    if (window.Channels) window.Channels.subscribeToChannelUpdates();
    subscribeToProfiles();
    subscribeToPinnedMessages();
    subscribeToIncomingCalls();

    // Last seen — обновляем сразу и каждые 60 сек
    updateLastSeen();
    if (lastSeenInterval) clearInterval(lastSeenInterval);
    lastSeenInterval = setInterval(() => {
      if (document.visibilityState !== 'hidden') updateLastSeen();
    }, 60000);

    // Ставим offline при скрытии вкладки / закрытии
    _initPresenceVisibility();

    // Обновляем видимость кнопок
    updateSendBtnVisibility();

    // Electron: обработка кликов по нативным уведомлениям
    if (window.electronAPI && window.electronAPI.onNotificationClick) {
      window.electronAPI.onNotificationClick((data) => {
        if (data.senderId) openChatWithUser(data.senderId);
      });
    }

    // Обработчики событий — вешаем только один раз за жизнь страницы
    if (!listenersInitialized) {
      initEventListeners();
      initDragAndDrop();
      initSidebarResizer();
      _initBurgerIconAnimations();
      initGroupMentionAutocomplete();
      listenersInitialized = true;

      // На мобильных — укорачиваем плейсхолдер поля ввода
      if (_isMobile) {
        const msgInput = getEl('message-input');
        if (msgInput) msgInput.placeholder = 'Сообщение...';
      }
    }

    // Service Worker + Push-уведомления
    initPushNotifications();

    // Регистрируем текущую сессию
    registerSession();

    // Проверка валидности сессии при возврате на вкладку
    document.addEventListener('visibilitychange', _checkSessionOnVisible, { once: false });
  }

  // Проверяем, жив ли аккаунт (профиль в БД), при возвращении на вкладку
  async function _checkSessionOnVisible() {
    if (document.visibilityState !== 'visible' || !currentUser) return;
    try {
      const { data: sessionData } = await window.supabaseClient.auth.getSession();
      if (!sessionData?.session) {
        // Сессия протухла или аккаунт удалён
        cleanup();
        document.removeEventListener('visibilitychange', _checkSessionOnVisible);
        window.App && window.App.onLogout();
        return;
      }
      // Проверяем, существует ли ещё профиль
      const { data: profile, error } = await window.supabaseClient
        .from('profiles')
        .select('id')
        .eq('id', currentUser.id)
        .maybeSingle();

      if (error || !profile) {
        // Профиль удалён — выходим
        await window.supabaseClient.auth.signOut();
        cleanup();
        document.removeEventListener('visibilitychange', _checkSessionOnVisible);
        window.App && window.App.onLogout();
        return;
      }

      // Проверяем, не была ли наша сессия завершена
      if (currentSessionId) {
        try {
          const { data: sessRow } = await window.supabaseClient
            .from('user_sessions')
            .select('id')
            .eq('id', currentSessionId)
            .maybeSingle();
          if (!sessRow) {
            // Сессия удалена с другого устройства
            _forceLogoutBySession();
          }
        } catch {} // таблица может не существовать
      }
    } catch { /* Нет сети — игнорируем */ }
  }

  // ============================================================
  // ---- Push-уведомления через Service Worker ----
  // ============================================================

  let swRegistration = null;

  async function initPushNotifications() {
    // ── Capacitor (Android APK): запрос runtime-разрешения на уведомления ──
    if (_isCapacitor) {
      try {
        const { LocalNotifications } = await import('https://cdn.jsdelivr.net/npm/@capacitor/local-notifications/+esm');
        if (LocalNotifications) {
          const perm = await LocalNotifications.checkPermissions();
          if (perm.display === 'prompt' || perm.display === 'prompt-with-rationale') {
            const result = await LocalNotifications.requestPermissions();
            console.log('[Capacitor] Notification permission:', result.display);
          }
          // Создаём каналы уведомлений для Android
          try {
            await LocalNotifications.createChannel({
              id: 'iflash_messages',
              name: 'Сообщения',
              description: 'Уведомления о новых сообщениях',
              importance: 4,
              visibility: 1,
              sound: 'yvedomlenia.mp3',
              vibration: true,
            });
            await LocalNotifications.createChannel({
              id: 'iflash_calls',
              name: 'Звонки',
              description: 'Входящие звонки',
              importance: 5,
              visibility: 1,
              sound: 'ringtone.mp3',
              vibration: true,
            });
          } catch {}
        }
      } catch (e) {
        console.warn('[Capacitor] Notification init error:', e);
      }
      return; // На Capacitor не нужен SW
    }

    // ── Веб / Electron: Service Worker + Web Notifications ──
    if (!('serviceWorker' in navigator) || !('Notification' in window)) return;

    try {
      // Регистрируем SW
      swRegistration = await navigator.serviceWorker.register('/sw.js');
      console.log('[SW] Registered:', swRegistration.scope);

      // Слушаем сообщения от SW (при клике на уведомление)
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'OPEN_CHAT' && event.data.senderId) {
          openChatWithUser(event.data.senderId);
        }
      });

      // Запрашиваем разрешение на уведомления
      if (Notification.permission === 'default') {
        // Показываем мягкий запрос через тост
        showPushPermissionToast();
      }
    } catch (e) {
      console.warn('[SW] Registration failed:', e);
    }
  }

  function showPushPermissionToast() {
    const toast = document.createElement('div');
    toast.className = 'push-permission-toast';
    toast.innerHTML = `
      <div class="push-perm-icon">🔔</div>
      <div class="push-perm-text">
        <strong>Включить уведомления?</strong>
        <span>Получайте уведомления о новых сообщениях</span>
      </div>
      <div class="push-perm-btns">
        <button class="push-perm-yes">Включить</button>
        <button class="push-perm-no">Не сейчас</button>
      </div>
    `;
    document.body.appendChild(toast);

    toast.querySelector('.push-perm-yes').addEventListener('click', async () => {
      toast.remove();
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        showToast('Уведомления включены', 'success');
      }
    });
    toast.querySelector('.push-perm-no').addEventListener('click', () => {
      toast.remove();
    });

    // Авто-скрытие через 8 сек
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 8000);
  }

  // ---- Кастомное in-app уведомление (пузырь IFlash) ----
  // ── Стек in-app уведомлений в стиле Telegram ──────────────────────────────
  let _notifStack = [];      // массив активных уведомлений
  const _NOTIF_MAX   = 5;   // максимум одновременно видимых
  const _NOTIF_LIFE  = 5000; // мс до авто-закрытия

  function _getOrCreateNotifStack() {
    let stack = document.getElementById('iflash-notif-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'iflash-notif-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function _dismissNotif(notif, timer) {
    clearTimeout(timer);
    if (!notif.parentNode || notif.classList.contains('iflash-notif-hide')) return;
    notif.classList.add('iflash-notif-hide');
    _notifStack = _notifStack.filter(n => n !== notif);
    setTimeout(() => { notif.remove(); }, 350);
  }

  function showInAppNotification(senderName, body, avatarUrl, onClick) {
    const stack = _getOrCreateNotifStack();
    const truncated = body && body.length > 60 ? body.slice(0, 60) + '…' : (body || '');

    const avatarHTML = avatarUrl
      ? `<img src="${escapeHTML(avatarUrl)}" class="iflash-notif-avatar" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<div class="iflash-notif-avatar iflash-notif-avatar-placeholder" style="display:none;">${escapeHTML((senderName || '?').charAt(0).toUpperCase())}</div>`
      : `<div class="iflash-notif-avatar iflash-notif-avatar-placeholder">${escapeHTML((senderName || '?').charAt(0).toUpperCase())}</div>`;

    const notif = document.createElement('div');
    notif.className = 'iflash-notification';
    notif.innerHTML = `
      <div class="iflash-notif-header">
        <img src="avat.png" class="iflash-notif-logo" alt="">
        <span class="iflash-notif-app-name">IFlash</span>
        <button class="iflash-notif-close" title="Закрыть">✕</button>
      </div>
      <div class="iflash-notif-body">
        ${avatarHTML}
        <div class="iflash-notif-content">
          <div class="iflash-notif-sender">${escapeHTML(senderName || '')}</div>
          <div class="iflash-notif-text">${escapeHTML(truncated)}</div>
        </div>
      </div>
    `;

    // Авто-таймер
    let dismissTimer = setTimeout(() => _dismissNotif(notif, dismissTimer), _NOTIF_LIFE);

    // Клик по уведомлению → открыть чат
    notif.addEventListener('click', (e) => {
      if (e.target.closest('.iflash-notif-close')) return;
      _dismissNotif(notif, dismissTimer);
      if (onClick) onClick();
    });

    // Кнопка закрытия
    notif.querySelector('.iflash-notif-close').addEventListener('click', (e) => {
      e.stopPropagation();
      _dismissNotif(notif, dismissTimer);
    });

    // Наведение → приостанавливаем авто-закрытие
    notif.addEventListener('mouseenter', () => { clearTimeout(dismissTimer); });
    notif.addEventListener('mouseleave', () => {
      dismissTimer = setTimeout(() => _dismissNotif(notif, dismissTimer), _NOTIF_LIFE);
    });

    // Если стек переполнен — убираем самое старое
    if (_notifStack.length >= _NOTIF_MAX) {
      _dismissNotif(_notifStack[0], null);
    }

    stack.appendChild(notif);
    _notifStack.push(notif);

    // Анимация появления
    requestAnimationFrame(() => {
      requestAnimationFrame(() => notif.classList.add('iflash-notif-show'));
    });

    // Звук
    _playNotificationSound();
  }

  // Показать нативное уведомление (OS-уровень, если страница не в фокусе)
  // + in-app пузырь если в фокусе
  async function showNativeNotification(senderName, body, senderId, group) {
    // Определяем аватар
    let avatarUrl = null;
    if (senderId) {
      const profile = allProfiles.find(p => p.id === senderId);
      if (profile && profile.avatar_url) avatarUrl = profile.avatar_url;
    }
    if (group && group.avatar_url) avatarUrl = group.avatar_url;

    const onClick = () => {
      window.focus();
      if (group) { openGroupChat(group); }
      else if (senderId) { openChatWithUser(senderId); }
    };

    // In-app пузырь (всегда показываем, если чат не открыт)
    showInAppNotification(senderName, body, avatarUrl, onClick);

    // Нативное OS-уведомление (только если не в фокусе)
    if (document.hasFocus()) return;

    const title = `IFlash — ${senderName}`;
    const truncated = body.length > 30 ? body.slice(0, 30) + '…' : body;
    const tag = group ? `grp-${group.id}` : `msg-${senderId}`;

    // Electron native notifications (Windows/Mac/Linux)
    if (window.electronAPI && window.electronAPI.showNotification) {
      window.electronAPI.showNotification({
        title,
        body: truncated,
        senderId: senderId || null,
        groupId: group?.id || null,
      });
      return;
    }

    // Capacitor Local Notifications (Android APK)
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      try {
        const { LocalNotifications } = await import('https://cdn.jsdelivr.net/npm/@capacitor/local-notifications/+esm');
        // Есть ли плагин на нативной стороне?
        if (LocalNotifications) {
          await LocalNotifications.schedule({
            notifications: [{
              title: 'IFlash',
              body: `${senderName}: ${truncated}`,
              id: Date.now() % 2147483647,
              smallIcon: 'ic_launcher',
              largeIcon: 'ic_launcher',
              sound: 'yvedomlenia.mp3',
              channelId: 'iflash_messages',
            }]
          });
          return;
        }
      } catch {}
    }

    // Web Notification API (ПК Electron + браузер)
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    // SW для мобильного браузера
    if (swRegistration) {
      try {
        await swRegistration.showNotification(title, {
          body: truncated,
          icon: '/avat.png',
          badge: '/avat.png',
          tag,
          renotify: true,
          vibrate: [150, 50, 150],
          data: { senderId, groupId: group?.id, url: '/' },
        });
        return;
      } catch {}
    }

    // Фоллбэк: прямой new Notification (ПК)
    try {
      const n = new Notification(title, {
        body: truncated,
        icon: '/avat.png',
        tag,
        renotify: true,
      });
      n.addEventListener('click', () => {
        onClick();
        n.close();
      });
      setTimeout(() => n.close(), 5000);
    } catch {}
  }

  // Уведомление о входящем звонке — всегда показывается (даже если приложение в фокусе)
  async function _showCallNotification(callerName, callerId) {
    const title = 'IFlash';
    const body  = `📞 Вам звонит ${callerName}`;

    // Electron (.exe) — нативное уведомление через ipc
    if (window.electronAPI && window.electronAPI.showNotification) {
      window.electronAPI.showNotification({ title, body, senderId: callerId });
      return;
    }

    // Capacitor Android (.apk)
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      try {
        const { LocalNotifications } = await import('https://cdn.jsdelivr.net/npm/@capacitor/local-notifications/+esm');
        if (LocalNotifications) {
          // Убедимся, что есть канал для звонков
          try {
            await LocalNotifications.createChannel({
              id: 'iflash_calls',
              name: 'Звонки IFlash',
              importance: 5,
              sound: 'zvonok.mp3',
              vibration: true,
            });
          } catch {}
          await LocalNotifications.schedule({
            notifications: [{
              title,
              body,
              id: (Date.now() % 2147483647) | 0,
              smallIcon: 'ic_launcher',
              largeIcon: 'ic_launcher',
              sound: 'zvonok.mp3',
              channelId: 'iflash_calls',
              ongoing: false,
            }]
          });
          return;
        }
      } catch {}
    }

    // Web Notification API (браузер / Electron без electronAPI)
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') {
      await Notification.requestPermission().catch(() => {});
    }
    if (Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, {
        body,
        icon: 'avat.png',
        tag: `call-${callerId}`,
        renotify: true,
        requireInteraction: true,
      });
      n.addEventListener('click', () => { window.focus(); n.close(); });
    } catch {}
  }

  // ============================================================
  // КОНТЕКСТНОЕ МЕНЮ ДИАЛОГА (ПКМ по диалогу в сайдбаре)
  // ============================================================

  function showConvContextMenu(e, userId, profile) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.conv-context-menu').forEach(m => m.remove());

    const isBlocked = blockedUsers.has(userId);
    const displayName = escapeHTML(getContactDisplayName(profile) || profile.username || 'Пользователь');

    const menu = document.createElement('div');
    menu.className = 'msg-context-menu conv-context-menu';
    menu.innerHTML = `
      <div class="ctx-menu-user-header">
        <span class="ctx-menu-user-name">${displayName}</span>
      </div>
      <div class="msg-ctx-divider"></div>
      <button class="msg-ctx-item" data-action="mark-unread">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        Пометить непрочитанным
      </button>
      <button class="msg-ctx-item msg-ctx-item--danger" data-action="delete-chat">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        Удалить чат
      </button>
      ${!isBlocked ? `<button class="msg-ctx-item msg-ctx-item--danger" data-action="block">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
        Заблокировать
      </button>` : ''}
    `;

    document.body.appendChild(menu);

    menu.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        menu.remove();
        if (action === 'mark-unread')  convCtxMarkUnread(userId);
        else if (action === 'delete-chat') convCtxConfirmDelete(userId, profile, displayName);
        else if (action === 'block')   convCtxShowBlockModal(userId, profile, displayName);
      });
    });

    // Позиционирование
    let x = e.clientX, y = e.clientY;
    menu.style.left = '0px'; menu.style.top = '-9999px';
    requestAnimationFrame(() => {
      const mh = menu.offsetHeight, mw = menu.offsetWidth;
      const vw = window.innerWidth, vh = window.innerHeight;
      if (x + mw > vw - 8)  x = vw - mw - 8;
      if (x < 8) x = 8;
      if (y + mh > vh - 8) y = y - mh - 8;
      if (y < 8) y = 8;
      if (_isMobile && mw > vw - 24) {
        x = 12;
        menu.style.width = (vw - 24) + 'px';
      }
      menu.style.left = x + 'px';
      menu.style.top  = y + 'px';
    });

    // Закрытие по клику вне меню
    const closeMenu = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', closeMenu);
        document.removeEventListener('touchstart', closeMenu);
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', closeMenu);
      document.addEventListener('touchstart', closeMenu, { passive: true });
    }, 50);

    // Закрытие по Escape
    const onKey = (ev) => {
      if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
  }

  function showGroupContextMenu(e, group) {
    e.preventDefault();
    document.querySelectorAll('.conv-context-menu').forEach(m => m.remove());

    const memberCache = groupMembersCache[group.id] || {};
    const members = memberCache.members || [];
    const me = members.find(m => m.user_id === currentUser?.id);
    const isMuted = me?.muted || false;
    const isPinned = (JSON.parse(localStorage.getItem('iflash_pinned_groups') || '[]')).includes(group.id);

    const menu = document.createElement('div');
    menu.className = 'msg-context-menu conv-context-menu';
    menu.innerHTML = `
      <div class="ctx-menu-user-header">
        <span class="ctx-menu-user-name">${escapeHTML(group.name)}</span>
      </div>
      <div class="msg-ctx-divider"></div>
      <button class="msg-ctx-item" data-action="pin">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        ${isPinned ? 'Открепить' : 'Закрепить'}
      </button>
      <button class="msg-ctx-item" data-action="mute">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/>${isMuted ? '<line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>' : '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'}
        </svg>
        ${isMuted ? 'Включить уведомления' : 'Отключить уведомления'}
      </button>
      <button class="msg-ctx-item" data-action="clear">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        Очистить чат (для меня)
      </button>
      <button class="msg-ctx-item msg-ctx-item--danger" data-action="leave">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Выйти из группы
      </button>
    `;
    document.body.appendChild(menu);
    _positionContextMenu(menu, e);
    _setupContextMenuClose(menu);

    menu.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        menu.remove();
        if (action === 'pin') {
          const pinned = JSON.parse(localStorage.getItem('iflash_pinned_groups') || '[]');
          if (isPinned) {
            const idx = pinned.indexOf(group.id);
            if (idx !== -1) pinned.splice(idx, 1);
            showToast('Группа откреплена', 'info');
          } else {
            pinned.unshift(group.id);
            showToast('Группа закреплена', 'success');
          }
          localStorage.setItem('iflash_pinned_groups', JSON.stringify(pinned));
          renderGroupsInList(getEl('conversations-list'));
        } else if (action === 'mute') {
          toggleGroupMute(group.id, !isMuted);
        } else if (action === 'clear') {
          clearGroupChatForMe(group.id);
        } else if (action === 'leave') {
          leaveGroup(group.id);
        }
      });
    });
  }

  function showChannelContextMenu(e, ch) {
    e.preventDefault();
    document.querySelectorAll('.conv-context-menu').forEach(m => m.remove());

    const isMuted = ch.muted || false;
    const isPinned = (JSON.parse(localStorage.getItem('iflash_pinned_channels') || '[]')).includes(ch.id);
    const isAdmin = ch.my_role === 'admin';

    const menu = document.createElement('div');
    menu.className = 'msg-context-menu conv-context-menu';
    menu.innerHTML = `
      <div class="ctx-menu-user-header">
        <span class="ctx-menu-user-name">${escapeHTML(ch.name)}</span>
      </div>
      <div class="msg-ctx-divider"></div>
      <button class="msg-ctx-item" data-action="pin">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        ${isPinned ? 'Открепить' : 'Закрепить'}
      </button>
      <button class="msg-ctx-item" data-action="mute">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/>${isMuted ? '<line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>' : '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>'}
        </svg>
        ${isMuted ? 'Включить уведомления' : 'Отключить уведомления'}
      </button>
      ${!isAdmin ? `<button class="msg-ctx-item msg-ctx-item--danger" data-action="leave">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Выйти из канала
      </button>` : ''}
    `;
    document.body.appendChild(menu);
    _positionContextMenu(menu, e);
    _setupContextMenuClose(menu);

    menu.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        menu.remove();
        if (action === 'pin') {
          const pinned = JSON.parse(localStorage.getItem('iflash_pinned_channels') || '[]');
          if (isPinned) {
            const idx = pinned.indexOf(ch.id);
            if (idx !== -1) pinned.splice(idx, 1);
            showToast('Канал откреплён', 'info');
          } else {
            pinned.unshift(ch.id);
            showToast('Канал закреплён', 'success');
          }
          localStorage.setItem('iflash_pinned_channels', JSON.stringify(pinned));
          if (window.Channels) window.Channels.renderChannelsInList(getEl('conversations-list'));
        } else if (action === 'mute') {
          if (window.Channels) window.Channels.toggleChannelMute(ch.id);
        } else if (action === 'leave') {
          if (window.Channels) window.Channels.leaveChannel(ch.id);
        }
      });
    });
  }

  function _positionContextMenu(menu, e) {
    let x = e.clientX, y = e.clientY;
    menu.style.left = '0px'; menu.style.top = '-9999px';
    requestAnimationFrame(() => {
      const mh = menu.offsetHeight, mw = menu.offsetWidth;
      const vw = window.innerWidth, vh = window.innerHeight;
      if (x + mw > vw - 8)  x = vw - mw - 8;
      if (x < 8) x = 8;
      if (y + mh > vh - 8) y = y - mh - 8;
      if (y < 8) y = 8;
      if (_isMobile && mw > vw - 24) {
        x = 12;
        menu.style.width = (vw - 24) + 'px';
      }
      menu.style.left = x + 'px';
      menu.style.top  = y + 'px';
    });
  }

  function _setupContextMenuClose(menu) {
    const closeOnClick = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', closeOnClick);
        document.removeEventListener('touchstart', closeOnClick);
      }
    };
    setTimeout(() => {
      document.addEventListener('mousedown', closeOnClick);
      document.addEventListener('touchstart', closeOnClick, { passive: true });
    }, 50);
    document.addEventListener('keydown', function onKey(ev) {
      if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('keydown', onKey); }
    });
  }

  async function leaveGroup(groupId) {
    if (!confirm('Выйти из группы?')) return;
    try {
      await window.supabaseClient.from('group_members').delete().eq('group_id', groupId).eq('user_id', currentUser.id);
      groups = groups.filter(g => g.id !== groupId);
      if (selectedGroup && selectedGroup.id === groupId) {
        selectedGroup = null;
        const welcome = getEl('welcome-screen');
        const chatArea = getEl('chat-area');
        if (welcome) welcome.style.display = '';
        if (chatArea) chatArea.style.display = 'none';
      }
      renderGroupsInList(getEl('conversations-list'));
      showToast('Вы вышли из группы', 'info');
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function toggleGroupMute(groupId, muted) {
    try {
      await window.supabaseClient.from('group_members').update({ muted }).eq('group_id', groupId).eq('user_id', currentUser.id);
      if (groupMembersCache[groupId]) {
        const me = groupMembersCache[groupId].members.find(m => m.user_id === currentUser.id);
        if (me) me.muted = muted;
      }
      showToast(muted ? 'Уведомления отключены' : 'Уведомления включены', 'success');
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  function clearGroupChatForMe(groupId) {
    if (!confirm('Очистить чат только для вас? Сообщения других участников не затронуты.')) return;
    const key = `iflash_clear_group_${groupId}`;
    localStorage.setItem(key, new Date().toISOString());
    if (selectedGroup && selectedGroup.id === groupId) {
      const container = getEl('messages-container');
      if (container) container.innerHTML = `<div class="no-messages"><div class="no-messages-icon">🧹</div><p>Чат очищен (только для вас)</p></div>`;
    }
    showToast('Чат очищен', 'success');
  }

  // ---- Пометить как непрочитанное ----
  async function convCtxMarkUnread(userId) {
    // Добавляем в постоянный Set — сохраняется при любых перерисовках
    manuallyUnreadUsers.add(userId);
    // В памяти — ставим unreadCount = 1 если его не было
    const conv = conversationsList.find(c => c.profile.id === userId);
    if (conv) conv.unreadCount = Math.max(conv.unreadCount || 0, 1);

    // В базе — последнее сообщение от этого пользователя помечаем непрочитанным
    try {
      const { data: msgs } = await window.supabaseClient
        .from('messages')
        .select('id')
        .eq('sender_id', userId)
        .eq('receiver_id', currentUser.id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (msgs && msgs.length > 0) {
        await window.supabaseClient
          .from('messages')
          .update({ is_read: false })
          .eq('id', msgs[0].id);
      }
    } catch (err) {
      console.error('Ошибка пометки непрочитанным:', err);
    }
    renderConversations();
    showToast('Помечено как непрочитанное', 'info');
  }

  // ---- Подтверждение удаления чата ----
  function convCtxConfirmDelete(userId, profile, displayName) {
    document.querySelectorAll('.conv-action-modal').forEach(m => m.remove());
    const modal = document.createElement('div');
    modal.className = 'modal-overlay conv-action-modal';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:340px;">
        <div class="modal-box-header">
          <h3>🗑️ Удалить чат</h3>
          <button class="modal-box-close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-box-body">
          <p class="modal-confirm-text">Удалить переписку с <strong>${displayName}</strong>?<br>
          Все сообщения будут <strong>удалены из базы данных навсегда</strong>.</p>
        </div>
        <div class="modal-box-footer">
          <button class="btn-cancel modal-close-btn">Отмена</button>
          <button class="btn-danger-sm confirm-action-btn">🗑️ Удалить</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('.modal-box-close').onclick = () => modal.remove();
    modal.querySelector('.modal-close-btn').onclick  = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('.confirm-action-btn').addEventListener('click', async () => {
      modal.remove();
      await convCtxDeleteChat(userId);
    });
  }

  // ---- Удаление чата (сообщения удаляются, диалог остаётся пустым) ----
  async function convCtxDeleteChat(userId) {
    if (!currentUser) return;
    let ok = true;
    // Удаляем исходящие
    const { error: e1 } = await window.supabaseClient.from('messages').delete()
      .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${userId}),and(sender_id.eq.${userId},receiver_id.eq.${currentUser.id})`);
    if (e1) { console.error('Ошибка удаления сообщений:', e1); ok = false; }

    if (!ok) {
      // Фоллбэк: пробуем двумя запросами
      try {
        await window.supabaseClient.from('messages').delete()
          .eq('sender_id', currentUser.id).eq('receiver_id', userId);
        await window.supabaseClient.from('messages').delete()
          .eq('sender_id', userId).eq('receiver_id', currentUser.id);
        ok = true;
      } catch (err) { console.error('Ошибка удаления (фоллбэк):', err); }
    }

    if (!ok) {
      showToast('Не удалось удалить сообщения из базы', 'error');
      return;
    }

    // Убираем из черновиков
    delete draftsMap[`user_${userId}`];

    // Если открыт этот чат — очищаем контейнер, но чат остаётся открытым
    if (selectedChat && selectedChat.id === userId) {
      renderedMessageIds.clear();
      const msgContainer = getEl('messages-container');
      if (msgContainer) {
        msgContainer.innerHTML = `
          <div class="empty-chat-hint" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;opacity:0.45;gap:8px;">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <span style="font-size:14px;">Чат очищен</span>
          </div>`;
      }
    }

    // Обновляем запись в памяти — очищаем lastMessage
    const convIdx = conversationsList.findIndex(c => c.profile && c.profile.id === userId);
    if (convIdx !== -1) {
      conversationsList[convIdx].lastMessage = { content: '', file_name: null, created_at: conversationsList[convIdx].lastMessage?.created_at || new Date().toISOString() };
      conversationsList[convIdx].unreadCount = 0;
    }

    renderConversations();
    showToast('Чат очищен', 'success');
  }

  // ---- Модалка блокировки (чат всегда удаляется) ----
  function convCtxShowBlockModal(userId, profile, displayName) {
    document.querySelectorAll('.conv-action-modal').forEach(m => m.remove());
    const modal = document.createElement('div');
    modal.className = 'modal-overlay conv-action-modal';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:340px;">
        <div class="modal-box-header">
          <h3>🚫 Заблокировать</h3>
          <button class="modal-box-close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-box-body">
          <p class="modal-confirm-text">Заблокировать <strong>${displayName}</strong>?<br>
          Он не сможет отправлять вам сообщения.<br>
          <span style="color:var(--text-muted);font-size:13px;">Вся переписка будет удалена из базы данных.</span></p>
        </div>
        <div class="modal-box-footer">
          <button class="btn-cancel modal-close-btn">Отмена</button>
          <button class="btn-danger-sm confirm-action-btn">🚫 Заблокировать</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('.modal-box-close').onclick = () => modal.remove();
    modal.querySelector('.modal-close-btn').onclick  = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('.confirm-action-btn').addEventListener('click', async () => {
      modal.remove();
      await convCtxBlockWithOptions(userId, true); // всегда удаляем чат
    });
  }

  // ---- Блокировка с опцией удаления чата ----
  async function convCtxBlockWithOptions(userId, shouldDeleteChat) {
    if (!currentUser) return;
    blockedUsers.add(userId);
    trustedUsers.delete(userId);
    saveBlockedUsers();

    try {
      await window.supabaseClient
        .from('user_blocks')
        .upsert({ blocker_id: currentUser.id, blocked_id: userId }, { onConflict: 'blocker_id,blocked_id' });
    } catch (err) {
      console.warn('user_blocks fallback:', err.message);
    }

    // Скрываем плашку незнакомца
    const banner = getEl('stranger-banner');
    if (banner) banner.style.display = 'none';

    // Закрываем чат если он открыт
    if (selectedChat && selectedChat.id === userId) {
      selectedChat = null;
      const chatArea = getEl('chat-area');
      const welcomeScreen = getEl('welcome-screen');
      if (chatArea) chatArea.style.display = 'none';
      if (welcomeScreen) welcomeScreen.style.display = '';
      const msgContainer = getEl('messages-container');
      if (msgContainer) msgContainer.innerHTML = '';
    }

    if (shouldDeleteChat) {
      try {
        await window.supabaseClient.from('messages').delete()
          .eq('sender_id', currentUser.id).eq('receiver_id', userId);
      } catch (err) { console.error(err); }
      try {
        await window.supabaseClient.from('messages').delete()
          .eq('sender_id', userId).eq('receiver_id', currentUser.id);
      } catch (err) { console.error(err); }
      delete draftsMap[`user_${userId}`];
    }

    loadConversations();
    showToast('Пользователь заблокирован', 'error');
  }

  // ---- Закрытие модального окна с анимацией ----
  function closeModalAnimated(overlayEl) {
    if (!overlayEl || overlayEl.classList.contains('closing')) return;
    overlayEl.classList.add('closing');
    setTimeout(() => {
      if (overlayEl.parentNode) overlayEl.remove();
    }, 230);
  }

  function initEventListeners() {
    // Глобальный перехват закрытия модальных окон — анимация исчезновения
    document.addEventListener('click', (e) => {
      // Кнопки закрытия внутри .modal-overlay
      if (e.target.closest('.modal-close-btn, .modal-box-close')) {
        const overlay = e.target.closest('.modal-overlay');
        if (overlay) {
          e.stopImmediatePropagation();
          closeModalAnimated(overlay);
        }
      }
      // Клик по фону оверлея (не по контенту)
      if (e.target.classList && e.target.classList.contains('modal-overlay')) {
        closeModalAnimated(e.target);
      }
    }, true); // capture phase

    // Поиск
    const searchInput = getEl('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => handleSearch(e.target.value), 300);
      });

      // Escape — сбрасываем поиск
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') clearSearch();
      });
    }

    // Поиск по сообщениям в чате
    const msgSearchInput = getEl('msg-search-input');
    if (msgSearchInput) {
      msgSearchInput.addEventListener('input', (e) => {
        clearTimeout(msgSearchTimer);
        const q = e.target.value.trim();
        msgSearchQuery = q;
        msgSearchTimer = setTimeout(() => performMsgSearch(q), 250);
      });
      // Закрытие по Escape
      msgSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') toggleMsgSearch();
      });
    }

    // ПКМ по диалогу в сайдбаре — контекстное меню
    const convListEl = getEl('conversations-list');
    if (convListEl) {
      convListEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // Группа?
        const groupItem = e.target.closest('.conversation-item[data-group-id]');
        if (groupItem) {
          const gid = groupItem.dataset.groupId;
          const grp = groups.find(g => g.id === gid);
          if (grp) showGroupContextMenu(e, grp);
          return;
        }
        // Канал?
        const channelItem = e.target.closest('.conversation-item[data-channel-id]');
        if (channelItem && window.Channels) {
          const cid = channelItem.dataset.channelId;
          const ch = window.Channels.channels.find(c => c.id === cid);
          if (ch) showChannelContextMenu(e, ch);
          return;
        }
        // Личный чат
        const item = e.target.closest('.conversation-item[data-user-id]');
        if (!item) return;
        const userId = item.dataset.userId;
        // Ищем профиль
        const profile =
          allProfiles.find(p => p.id === userId) ||
          conversationsList.find(c => c.profile.id === userId)?.profile;
        if (!profile) return;
        showConvContextMenu(e, userId, profile);
      });
    }

    // Кнопка настроек (бургер)
    const settingsBtn = getEl('settings-btn');
    if (settingsBtn) settingsBtn.addEventListener('click', toggleSettings);

    // Закрытие бургер-меню по клику на оверлей
    const overlay = getEl('settings-overlay');
    if (overlay) overlay.addEventListener('click', closeMenu);

    // Отправка сообщения
    const sendBtn = getEl('send-btn');
    if (sendBtn) sendBtn.addEventListener('click', sendMessage);

    const messageInput = getEl('message-input');
    if (messageInput) {
      messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      // Контекстное меню форматирования при ПКМ с выделенным текстом
      messageInput.addEventListener('contextmenu', (e) => {
        if (messageInput.selectionStart !== messageInput.selectionEnd) {
          showInputFormatMenu(e);
        }
      });

      // Авторастягивание + видимость кнопок + typing + черновик
      messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
        updateSendBtnVisibility();
        if (selectedChat) sendTypingEvent();
        // Счётчик символов (показываем при > 8000)
        const charCounter = getEl('msg-char-counter');
        if (charCounter) {
          const len = messageInput.value.length;
          if (len > 8000) {
            charCounter.style.display = 'block';
            charCounter.textContent = `${len} / 10000`;
            charCounter.style.color = len > 9500 ? 'var(--error-color, #ff4444)' : 'var(--text-muted)';
          } else {
            charCounter.style.display = 'none';
          }
        }
        // Сохраняем черновик синхронно
        const key = getDraftKey();
        if (key) {
          const val = messageInput.value;
          if (val.trim()) {
            draftsMap[key] = val;
          } else {
            delete draftsMap[key];
          }
          // Обновляем превью в сайдбаре с дебаунсом
          clearTimeout(draftSidebarTimer);
          draftSidebarTimer = setTimeout(updateDraftPreviewInSidebar, 350);
        }
      });
    }

    // Кнопка микрофона — клик показывает выбор (голос / видеокружок)
    const micBtn = getEl('mic-btn');
    if (micBtn) {
      micBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleVoiceModePicker();
      });
      micBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        toggleVoiceModePicker();
      }, { passive: false });
    }

    // Прикрепление файла
    const attachBtn = getEl('attach-btn');
    if (attachBtn) attachBtn.addEventListener('click', () => getEl('file-input')?.click());

    const fileInput = getEl('file-input');
    if (fileInput) fileInput.addEventListener('change', handleFileSelect);

    // Аватар
    const avatarInput = getEl('avatar-input');
    if (avatarInput) avatarInput.addEventListener('change', handleAvatarChange);

    // Отображаемое имя в настройках
    const displayNameBtn = getEl('settings-displayname-btn');
    if (displayNameBtn) displayNameBtn.addEventListener('click', handleDisplayNameChange);

    const displayNameInput = getEl('settings-displayname-input');
    if (displayNameInput) {
      displayNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleDisplayNameChange();
      });
    }

    // Смена пароля
    const passwordBtn = getEl('settings-password-btn');
    if (passwordBtn) passwordBtn.addEventListener('click', handlePasswordChange);

    // Закрытие пикеров реакций при клике вне
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.reaction-picker-wrap')) {
        closeAllReactionPickers();
      }
    });

    // Темы — обработчики навешены через onclick в HTML

    // Закрытие модальных окон
    const profileModal = getEl('profile-modal');
    if (profileModal) {
      profileModal.addEventListener('click', (e) => {
        if (e.target === profileModal) closeProfileModal();
      });
    }

    const imageModal = getEl('image-modal');
    if (imageModal) {
      imageModal.addEventListener('click', (e) => {
        if (e.target === imageModal || e.target.id === 'image-modal') closeImageModal();
      });
    }

    // Кнопка выхода
    const logoutBtn = getEl('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', Auth.handleLogout);

    // Кнопка создания инвайта
    const createInviteBtn = getEl('create-invite-btn');
    if (createInviteBtn) createInviteBtn.addEventListener('click', createInviteCode);

    // Кнопка обновления списка инвайтов
    const refreshInvitesBtn = getEl('refresh-invites-btn');
    if (refreshInvitesBtn) refreshInvitesBtn.addEventListener('click', async () => {
      refreshInvitesBtn.disabled = true;
      refreshInvitesBtn.textContent = '⏳';
      await loadInvitesList();
      refreshInvitesBtn.disabled = false;
      refreshInvitesBtn.textContent = '🔄 Обновить';
    });

    // Кнопка удаления аккаунта
    const deleteAccountBtn = getEl('delete-account-btn');
    if (deleteAccountBtn) deleteAccountBtn.addEventListener('click', deleteAccount);

    // Кнопка «Новая группа» в сайдбаре
    const newGroupBtn = getEl('new-group-btn');
    if (newGroupBtn) newGroupBtn.addEventListener('click', openCreateGroupModal);

    // Подтверждение создания группы
    const confirmGroupBtn = getEl('confirm-create-group-btn');
    if (confirmGroupBtn) confirmGroupBtn.addEventListener('click', confirmCreateGroup);

    // Поиск участников в модалке создания группы
    const groupSearchInput = getEl('group-member-search');
    if (groupSearchInput) {
      groupSearchInput.addEventListener('input', (e) => {
        renderGroupMemberResults(e.target.value);
      });
    }

    // Закрытие модалки группы по клику на оверлей
    const createGroupModal = getEl('create-group-modal');
    if (createGroupModal) {
      createGroupModal.addEventListener('click', (e) => {
        if (e.target === createGroupModal) closeCreateGroupModal();
      });
    }

    // Поиск в модалке пересылки
    const forwardSearch = getEl('forward-search');
    if (forwardSearch) {
      forwardSearch.addEventListener('input', (e) => renderForwardList(e.target.value));
    }

    // Делегированный обработчик выделения сообщений (capture-фаза)
    const msgContainer = getEl('messages-container');
    if (msgContainer) {
      msgContainer.addEventListener('click', (e) => {
        if (!selectionMode) return;
        // Не реагируем на клики по кнопкам и ссылкам внутри сообщения
        if (e.target.closest('a, button, .msg-ctx-item')) return;
        const wrapper = e.target.closest('.message-wrapper, .gm-wrapper');
        if (!wrapper) return;
        const msgId = wrapper.dataset.msgId;
        if (msgId) toggleMessageSelection(msgId);
      }, true); // capture = true, чтобы перехватить до других обработчиков
    }
  }

  // ---- Генерация инвайт-кода ----
  function generateInviteCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'IFlash_';
    for (let i = 0; i < 16; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // ---- Создание нового инвайта ----
  async function createInviteCode() {
    if (!currentUser || currentUser.id !== DEV_UID) return;

    const btn = getEl('create-invite-btn');
    const resultEl = getEl('invite-create-result');
    const codeEl = getEl('invite-created-code');

    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span>';

    try {
      const code = generateInviteCode();

      const { error } = await window.supabaseClient
        .from('invite_codes')
        .insert({ code, created_by: currentUser.id });

      if (error) {
        showToast('Ошибка создания инвайта: ' + error.message, 'error');
        return;
      }

      // Показываем созданный код
      codeEl.textContent = code;
      resultEl.style.display = 'flex';

      // Копируем в буфер автоматически
      try {
        await navigator.clipboard.writeText(code);
        showToast('Инвайт создан и скопирован!', 'success');
      } catch {
        showToast('Инвайт создан! Скопируйте вручную.', 'success');
      }

      // Обновляем список инвайтов
      await loadInvitesList();

    } catch (err) {
      showToast('Ошибка: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '✦ Создать инвайт';
    }
  }

  // ---- Копирование инвайт-кода ----
  async function copyInviteCode() {
    const codeEl = getEl('invite-created-code');
    if (!codeEl) return;
    try {
      await navigator.clipboard.writeText(codeEl.textContent);
      showToast('Код скопирован!', 'success');
    } catch {
      showToast('Не удалось скопировать', 'error');
    }
  }

  // ---- Загрузка списка инвайтов ----
  async function loadInvitesList() {
    if (!currentUser || currentUser.id !== DEV_UID) return;

    const listEl = getEl('invites-list');
    if (!listEl) return;

    listEl.innerHTML = '<div class="invites-loading">Загрузка...</div>';

    try {
      const { data, error } = await window.supabaseClient
        .from('invite_codes')
        .select('code, created_at, used_by, used_at')
        .eq('created_by', currentUser.id)
        .order('created_at', { ascending: false });

      if (error) {
        listEl.innerHTML = '<div class="invites-loading">Ошибка загрузки</div>';
        return;
      }

      if (!data || data.length === 0) {
        listEl.innerHTML = '<div class="invites-loading">Нет инвайтов</div>';
        return;
      }

      listEl.innerHTML = data.map(inv => {
        const isUsed = !!inv.used_by;
        const date = new Date(inv.created_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
        const usedDate = inv.used_at ? new Date(inv.used_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';
        return `
          <div class="invite-item ${isUsed ? 'invite-item--used' : 'invite-item--active'}"
               data-invite-code="${escapeHTML(inv.code)}"
               oncontextmenu="Chat._inviteCtxMenu(event, '${escapeHTML(inv.code)}')"
               title="ПКМ — контекстное меню">
            <div class="invite-item-code">${escapeHTML(inv.code)}</div>
            <div class="invite-item-meta">
              <span class="invite-item-date">${isUsed ? '✓ использован ' + usedDate : date}</span>
              <span class="invite-item-status ${isUsed ? 'status-used' : 'status-active'}">
                ${isUsed ? '✓ Зарегистрирован' : '○ Свободен'}
              </span>
            </div>
          </div>
        `;
      }).join('');

    } catch (err) {
      listEl.innerHTML = '<div class="invites-loading">Ошибка</div>';
    }
  }

  // ---- Контекстное меню инвайта (ПКМ) ----
  function _inviteCtxMenu(e, code) {
    e.preventDefault();
    e.stopPropagation();

    // Удаляем старые меню
    document.querySelectorAll('.invite-ctx-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'msg-context-menu invite-ctx-menu';
    menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:9999;`;
    menu.innerHTML = `
      <button class="msg-ctx-item" data-action="copy-invite">📋 Скопировать код</button>
      <button class="msg-ctx-item msg-ctx-item--danger" data-action="delete-invite">🗑️ Удалить инвайт</button>
    `;
    document.body.appendChild(menu);

    menu.querySelector('[data-action="copy-invite"]').addEventListener('click', async () => {
      menu.remove();
      try {
        await navigator.clipboard.writeText(code);
        showToast('Код скопирован!', 'success');
      } catch {
        showToast('Не удалось скопировать', 'error');
      }
    });

    menu.querySelector('[data-action="delete-invite"]').addEventListener('click', async () => {
      menu.remove();
      await _deleteInviteCode(code);
    });

    // Закрытие по клику вне меню
    const close = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); }
    };
    setTimeout(() => document.addEventListener('click', close), 10);
  }

  // ---- Удаление инвайта из БД ----
  async function _deleteInviteCode(code) {
    if (!currentUser || currentUser.id !== DEV_UID) return;
    if (!confirm(`Удалить инвайт?\n${code}`)) return;

    try {
      const { error } = await window.supabaseClient
        .from('invite_codes')
        .delete()
        .eq('code', code)
        .eq('created_by', currentUser.id);

      if (error) throw error;
      showToast('Инвайт удалён', 'success');
      await loadInvitesList();
    } catch (err) {
      showToast('Ошибка удаления: ' + err.message, 'error');
      console.error('[deleteInvite]', err);
    }
  }

  // ---- Удаление аккаунта ----
  async function deleteAccount() {
    if (!currentUser) return;

    // Двойное подтверждение
    const confirmed1 = window.confirm(
      '⚠️ Удалить аккаунт?\n\nВсе ваши данные, сообщения и профиль будут удалены навсегда. Это действие нельзя отменить.'
    );
    if (!confirmed1) return;

    const confirmed2 = window.confirm(
      'Вы уверены? Это последнее предупреждение.\n\nНажмите OK для окончательного удаления аккаунта.'
    );
    if (!confirmed2) return;

    const btn = getEl('delete-account-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Удаление...'; }

    try {
      // Вызываем RPC delete_account (SECURITY DEFINER) — удаляет профиль + auth user
      const { error } = await window.supabaseClient.rpc('delete_account');

      if (error) {
        // Если RPC нет — удаляем хотя бы профиль и выходим
        console.warn('delete_account RPC error:', error.message);
        await window.supabaseClient.from('profiles').delete().eq('id', currentUser.id);
      }

      // Выход из сессии и редирект на экран авторизации
      await window.supabaseClient.auth.signOut();
      cleanup();
      window.App && window.App.onLogout();
    } catch (err) {
      console.error('Ошибка удаления аккаунта:', err);
      showToast('Ошибка удаления аккаунта: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = '🗑️ Удалить аккаунт'; }
    }
  }

  // ============================================================
  // ГРУППОВЫЕ ЧАТЫ
  // ============================================================
  let groups = [];                    // Список групп текущего пользователя
  let selectedGroup = null;           // Выбранная группа
  let groupRealtimeSubscription = null;
  let groupMembersCache = {};         // { groupId: [profiles...] }
  let lastGroupMsgSenderId = null;    // Для Telegram-стиля (предыдущий отправитель)
  let groupSelectedMembers = [];      // Выбранные участники при создании группы
  let groupUnreadMap = {};            // { groupId: count } — непрочитанные сообщения групп

  // ---- Загрузка групп ----
  async function loadGroups() {
    if (!currentUser) return;
    try {
      // Метод 1: через RPC get_my_groups() (после fix_groups_rls_v3.sql)
      const { data: rpcData, error: rpcErr } = await window.supabaseClient
        .rpc('get_my_groups');

      if (!rpcErr && rpcData) {
        groups = rpcData;
        console.log('[Groups] rpc loaded:', groups.length, groups.map(g => g.name));
        return;
      }

      console.warn('[Groups] rpc error:', rpcErr?.message, '— пробуем прямой запрос');

      // Метод 2: прямой запрос к group_members (работает если RLS отключён)
      const { data: memberRows, error: mErr } = await window.supabaseClient
        .from('group_members')
        .select('group_id')
        .eq('user_id', currentUser.id);

      if (!mErr && memberRows && memberRows.length > 0) {
        const groupIds = memberRows.map(r => r.group_id);
        const { data: groupData, error: gErr } = await window.supabaseClient
          .from('groups')
          .select('*')
          .in('id', groupIds);
        if (!gErr) {
          groups = groupData || [];
          console.log('[Groups] direct loaded:', groups.length);
          return;
        }
      }

      // Метод 3: последний fallback — только созданные мной группы
      console.warn('[Groups] fallback to created_by');
      const { data: ownGroups, error: ownErr } = await window.supabaseClient
        .from('groups')
        .select('*')
        .eq('created_by', currentUser.id);
      groups = (!ownErr && ownGroups) ? ownGroups : [];
      console.log('[Groups] fallback loaded:', groups.length);

    } catch (e) {
      console.error('[Groups] loadGroups exception:', e);
      groups = [];
    }
  }

  // ---- Загрузка непрочитанных сообщений для групп ----
  async function _loadGroupUnreadCounts() {
    if (!currentUser || !groups.length) return;
    groupUnreadMap = {};
    for (const group of groups) {
      const lastRead = localStorage.getItem(`grp_last_read_${group.id}`);
      if (!lastRead) continue;
      try {
        const { count } = await window.supabaseClient
          .from('group_messages')
          .select('id', { count: 'exact', head: true })
          .eq('group_id', group.id)
          .neq('sender_id', currentUser.id)
          .gt('created_at', lastRead);
        if (count > 0) groupUnreadMap[group.id] = count;
      } catch {}
    }
  }

  // ---- Рендер групп в списке диалогов ----
  function renderGroupsInList(container) {
    // Удаляем старые группы чтобы не дублировались при перерисовке
    container.querySelectorAll('.conv-group-item').forEach(el => el.remove());

    if (!groups || groups.length === 0) return;

    // Вставляем группы в самый верх списка (закреплённые — первыми)
    const pinnedGroups = JSON.parse(localStorage.getItem('iflash_pinned_groups') || '[]');
    const sortedGroups = [...groups].sort((a, b) => {
      const aPin = pinnedGroups.indexOf(a.id);
      const bPin = pinnedGroups.indexOf(b.id);
      if (aPin !== -1 && bPin === -1) return -1;
      if (aPin === -1 && bPin !== -1) return 1;
      if (aPin !== -1 && bPin !== -1) return aPin - bPin;
      return 0;
    });
    const firstChild = container.firstChild;
    // Строим через DocumentFragment — правильный порядок (закреплённые первыми)
    const grpFragment = document.createDocumentFragment();
    sortedGroups.forEach(group => {
      const isActive = selectedGroup && selectedGroup.id === group.id;
      const div = document.createElement('div');
      div.className = `conversation-item conv-group-item${isActive ? ' active' : ''}`;
      div.dataset.groupId = group.id;
      div.onclick = () => openGroupChat(group);
      const grpAvatarInList = group.avatar_url
        ? `<img src="${group.avatar_url}" style="width:46px;height:46px;border-radius:13px;object-fit:cover;flex-shrink:0;" alt="group">`
        : `<div class="conv-group-avatar"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="7" r="3"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0-3-3.85"/></svg></div>`;
      const grpDraftKey = `group_${group.id}`;
      const grpDraft = draftsMap[grpDraftKey];
      let grpPreviewHTML;
      if (grpDraft && grpDraft.trim()) {
        const dp = grpDraft.length > 32 ? grpDraft.slice(0, 32) + '…' : grpDraft;
        grpPreviewHTML = `<span class="draft-label">Черновик:</span> ${escapeHTML(dp)}`;
      } else {
        grpPreviewHTML = 'Групповой чат';
      }
      const grpUnread = groupUnreadMap[group.id] || 0;
      div.innerHTML = `
        ${grpAvatarInList}
        <div class="conv-info">
          <div class="conv-header">
            <span class="conv-name" style="display:flex;align-items:center;gap:2px;">${escapeHTML(group.name)}${(window.IFlashSub && window.IFlashSub.isVerifiedGroup(group.id)) ? window.IFlashSub.verifiedBadgeHTML() : ''}${pinnedGroups.includes(group.id) ? ' 📌' : ''}</span>
            ${grpUnread > 0 ? `<span class="unread-badge">${grpUnread}</span>` : '<span class="conv-group-tag">Группа</span>'}
          </div>
          <div class="conv-preview"><span class="conv-text">${grpPreviewHTML}</span></div>
        </div>
      `;
      grpFragment.appendChild(div);
    });
    container.insertBefore(grpFragment, firstChild);

    // Рендерим каналы вслед за группами
    if (window.Channels) window.Channels.renderChannelsInList(container);
  }

  // ---- Открыть групповой чат ----
  async function openGroupChat(group) {
    // ── Инвалидируем предыдущую загрузку сообщений ──
    ++_chatLoadGen;

    selectedGroup = group;
    selectedChat = null;
    // Сбрасываем счётчик непрочитанных и запоминаем время последнего визита
    groupUnreadMap[group.id] = 0;
    localStorage.setItem(`grp_last_read_${group.id}`, new Date().toISOString());
    _updateSendOnlineBtn(); // скрываем кнопку «в сети» для групп
    // Сбрасываем канал
    if (window.Channels) window.Channels.clearSelectedChannel();
    // Удаляем панель канала при переходе в группу
    const _oldChannelFooter = document.getElementById('channel-footer-panel');
    if (_oldChannelFooter) _oldChannelFooter.remove();
    const _channelInputArea = document.querySelector('.chat-input-area');
    if (_channelInputArea) _channelInputArea.style.display = '';

    // Обновляем активный элемент в списке диалогов немедленно
    document.querySelectorAll('.conversation-item').forEach(el => el.classList.remove('active'));
    const _activeGroupEl = document.querySelector(`.conversation-item[data-group-id="${group.id}"]`);
    if (_activeGroupEl) _activeGroupEl.classList.add('active');

    // Загрузить участников группы (всегда обновляем при открытии)
    try {
      const { data: members } = await window.supabaseClient
        .from('group_members')
        .select('user_id, role, muted')
        .eq('group_id', group.id);
      const memberIds = (members || []).map(m => m.user_id);
      // Подгружаем профили тех участников, которых нет в кэше
      const knownIds = new Set(allProfiles.map(p => p.id));
      const missingIds = memberIds.filter(id => !knownIds.has(id));
      if (missingIds.length > 0) {
        try {
          const { data: missingProfiles } = await window.supabaseClient
            .from('profiles').select('*').in('id', missingIds);
          if (missingProfiles) _cacheProfiles(missingProfiles);
        } catch (_) {}
      }
      const profiles = allProfiles.filter(p => memberIds.includes(p.id));
      groupMembersCache[group.id] = { members: members || [], profiles };
    } catch { groupMembersCache[group.id] = { members: [], profiles: [] }; }

    // Отрисовка шапки
    const headerEl = getEl('chat-header-content');
    const memberCache = groupMembersCache[group.id];
    const memberCount = (memberCache?.members || []).length;
    // Подготовить строку статуса: ники через запятую если ≤4, иначе "N участников"
    const memberProfiles = memberCache?.profiles || [];
    let statusStr;
    if (memberProfiles.length <= 4 && memberProfiles.length > 0) {
      statusStr = memberProfiles.map(p => getDisplayName(p)).join(', ');
    } else {
      statusStr = memberCount + ' участник' + (memberCount === 1 ? '' : memberCount < 5 ? 'а' : 'ов');
    }
    // Аватарка группы (если есть) или иконка
    const groupAvatarHTML = group.avatar_url
      ? `<img src="${group.avatar_url}" style="width:40px;height:40px;border-radius:13px;object-fit:cover;flex-shrink:0;" alt="group">`
      : `<div class="conv-group-avatar" style="width:40px;height:40px;border-radius:13px;flex-shrink:0;cursor:pointer;" onclick="Chat.openGroupInfo()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="7" r="3"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0-3-3.85"/></svg>
        </div>`;
    if (headerEl) {
      headerEl.innerHTML = `
        <button class="back-btn" onclick="Chat.goBackToList()" title="Назад">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div class="chat-header-user" style="cursor:pointer;" onclick="Chat.openGroupInfo()">
          ${groupAvatarHTML}
          <div class="chat-header-info">
            <span class="chat-header-name" style="display:flex;align-items:center;gap:3px;">${escapeHTML(group.name)}${(window.IFlashSub && window.IFlashSub.isVerifiedGroup(group.id)) ? window.IFlashSub.verifiedBadgeHTML() : ''}</span>
            <span class="chat-header-status group-header-status" title="${escapeHTML(statusStr)}">${escapeHTML(statusStr)}</span>
          </div>
        </div>
        <div class="chat-header-actions">
          <button class="chat-header-action-btn" onclick="Chat.generateGroupInviteLink()" title="Пригласить по ссылке">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </button>
        </div>
      `;
    }

    // Показываем закреплённое сообщение для группы
    loadAndShowPinBar();

    // Показываем чат, скрываем welcome
    const welcome = getEl('welcome-screen');
    const chatArea = getEl('chat-area');
    const stranger = getEl('stranger-banner');
    const blocked = getEl('blocked-screen');
    const msgContainer = getEl('messages-container');
    const inputArea = document.querySelector('.chat-input-area');
    const msgSearchBar = getEl('msg-search-bar');

    if (welcome) welcome.style.display = 'none';
    if (chatArea) { chatArea.style.display = 'flex'; chatArea.style.flexDirection = 'column'; }
    if (stranger) stranger.style.display = 'none';
    if (blocked) blocked.style.display = 'none';
    if (msgContainer) {
      msgContainer.style.display = '';
      msgContainer.classList.remove('chat-enter');
      void msgContainer.offsetWidth;
      msgContainer.classList.add('chat-enter');
      msgContainer.addEventListener('animationend', () => msgContainer.classList.remove('chat-enter'), { once: true });
    }
    if (inputArea) inputArea.style.display = '';
    // Скрываем строку поиска при смене чата
    if (msgSearchBar) msgSearchBar.style.display = 'none';
    if (msgSearchActive) {
      msgSearchActive = false;
      const si = getEl('msg-search-input');
      if (si) si.value = '';
    }

    // На мобильных — показываем правую панель (скрываем сайдбар)
    const sidebar = document.querySelector('.sidebar');
    const mainChat = document.querySelector('.main-chat');
    if (window.innerWidth <= 768) {
      if (sidebar) sidebar.classList.add('hidden-mobile');
      if (mainChat) mainChat.classList.add('visible-mobile');
    }

    // Загружаем сообщения
    await loadGroupMessages(group.id);

    // Восстанавливаем черновик для этой группы
    restoreDraftForCurrentChat();

    // Realtime-подписка
    if (groupRealtimeSubscription) {
      window.supabaseClient.removeChannel(groupRealtimeSubscription);
    }
    groupRealtimeSubscription = window.supabaseClient
      .channel('group_messages_' + group.id)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'group_messages',
        filter: `group_id=eq.${group.id}`
      }, payload => {
        if (selectedGroup && selectedGroup.id === group.id) {
          appendGroupMessage(payload.new);
        }
      })
      // Удаление для всех — убираем из UI у всех участников группы
      // ВАЖНО: нужен REPLICA IDENTITY FULL на таблице group_messages
      .on('postgres_changes', {
        event: 'DELETE',
        schema: 'public',
        table: 'group_messages',
        filter: `group_id=eq.${group.id}`
      }, payload => {
        const msgId = payload.old?.id;
        if (msgId) {
          const el = document.querySelector(`[data-msg-id="${msgId}"]`);
          if (el) el.remove();
          renderedMessageIds.delete(msgId);
        }
      })
      .subscribe();
  }

  // ---- Загрузить сообщения группы ----
  async function loadGroupMessages(groupId) {
    const container = getEl('messages-container');
    if (!container) return;
    container.innerHTML = `
      <div class="messages-loading">
        <div class="loading-spinner"></div>
        <span>Загрузка сообщений...</span>
      </div>`;
    renderedMessageIds.clear();

    try {
      const { data, error } = await window.supabaseClient
        .from('group_messages')
        .select('*')
        .eq('group_id', groupId)
        .order('created_at', { ascending: true })
        .limit(100);

      if (error) {
        console.error('[GroupMessages] error:', error.message);
        container.innerHTML = `<div class="messages-error">Ошибка загрузки: ${escapeHTML(error.message)}</div>`;
        return;
      }

      container.innerHTML = '';
      lastGroupMsgSenderId = null;

      if (!data || data.length === 0) {
        container.innerHTML = `
          <div class="no-messages">
            <div class="no-messages-icon">👋</div>
            <p>Начните общение в группе!</p>
          </div>`;
        return;
      }

      // Pre-fetch any sender profiles not yet in allProfiles cache
      const knownIds = new Set(allProfiles.map(p => p.id));
      knownIds.add(currentUser.id);
      const missingSenderIds = [...new Set(data.map(m => m.sender_id))].filter(id => !knownIds.has(id));
      if (missingSenderIds.length > 0) {
        try {
          const { data: newProfiles } = await window.supabaseClient
            .from('profiles')
            .select('*')
            .in('id', missingSenderIds);
          if (newProfiles) _cacheProfiles(newProfiles);
        } catch (_) {}
      }

      _loadingGroupHistory = true;
      for (const msg of data) { await appendGroupMessage(msg); }
      _loadingGroupHistory = false;
      // Load reactions for all group messages (reuse message_reactions table)
      await loadReactionsForMessages(data.map(m => m.id));
      container.scrollTop = container.scrollHeight;
    } catch (e) {
      console.error('[GroupMessages] exception:', e);
      container.innerHTML = '<div class="messages-error">Ошибка загрузки</div>';
    }
  }

  // ---- Отрисовать сообщение группы (Telegram-стиль) ----
  let _loadingGroupHistory = false;
  async function appendGroupMessage(msg) {
    if (renderedMessageIds.has(msg.id)) return;
    renderedMessageIds.add(msg.id);
    const container = getEl('messages-container');
    if (!container) return;

    const isMine = msg.sender_id === currentUser.id;
    // Уведомление только для НОВЫХ realtime-сообщений, не при загрузке истории
    if (!isMine && !_loadingGroupHistory) {
      // Уведомление для группы (in-app пузырь + нативное + звук)
      const sender = allProfiles.find(p => p.id === msg.sender_id);
      const senderName = sender ? getDisplayName(sender) : 'Участник';
      const groupName = selectedGroup ? selectedGroup.name : 'Группа';
      let preview;
      if (msg.file_name && msg.file_name.startsWith('vidnote_')) { preview = '🎥 Кружок'; }
      else if (msg.file_name && msg.file_name.startsWith('voice_')) { preview = '🎤 Голосовое сообщение'; }
      else if (msg.file_name) { preview = `📎 ${msg.file_name}`; }
      else { preview = msg.content || ''; }
      showNativeNotification(`${senderName} • ${groupName}`, preview, null, selectedGroup);
    }
    // If sender not in cache, fetch their profile on-the-fly
    let sender = allProfiles.find(p => p.id === msg.sender_id);
    if (!sender && !isMine) {
      try {
        const { data: sp } = await window.supabaseClient
          .from('profiles').select('*').eq('id', msg.sender_id).maybeSingle();
        if (sp) { _cacheProfile(sp); sender = sp; }
      } catch (_) {}
    }
    const senderName = sender ? getContactDisplayName(sender) : 'Участник';

    // Telegram-стиль: показываем аватар+имя только если sender сменился
    const isFirstInSequence = (msg.sender_id !== lastGroupMsgSenderId);
    lastGroupMsgSenderId = msg.sender_id;

    const time = new Date(msg.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    let bodyHTML = '';
    if (msg.content) {
      // Проверяем, является ли контент пригласительной ссылкой группы/канала
      const groupInviteMatch = msg.content.match(/^IFlashGROUP_([0-9a-f-]{36})$/);
      const channelInviteMatch = msg.content.match(/^IFlashCHANNEL_([0-9a-f-]{36})$/);
      if (groupInviteMatch) {
        const gid = groupInviteMatch[1];
        bodyHTML += `<div class="msg-text group-invite-link" onclick="Chat._handleGroupInviteClick('${gid}')" title="Нажмите, чтобы вступить в группу">
          <span class="group-invite-icon">👥</span>
          <div>
            <span class="group-invite-text">Приглашение в группу</span>
            <span class="group-invite-sub">Нажмите, чтобы вступить</span>
          </div>
        </div>`;
      } else if (channelInviteMatch) {
        const cid = channelInviteMatch[1];
        bodyHTML += `<div class="msg-text group-invite-link" onclick="if(window.Channels)Channels.handleChannelInviteClick('${cid}')" title="Нажмите, чтобы вступить в канал">
          <span class="group-invite-icon">📢</span>
          <div>
            <span class="group-invite-text">Приглашение в канал</span>
            <span class="group-invite-sub">Нажмите, чтобы вступить</span>
          </div>
        </div>`;
      } else {
        // Проверяем специальные форматы комментариев канала
        const postRefMatch = msg.content.match(/^📢POST_REF:([^\n📢]+)📢\n?([\s\S]*)/);
        const commentRefMatch = msg.content.match(/^💬POST:([^\n💬]+)💬\n?([\s\S]*)/);
        if (postRefMatch) {
          const preview = escapeHTML(postRefMatch[2] || '').slice(0, 200);
          bodyHTML += `<div class="group-post-ref">
            <span class="group-post-ref-icon">📢</span>
            <div class="group-post-ref-body">
              <span class="group-post-ref-label">Пост из канала</span>
              <span class="group-post-ref-text">${preview}</span>
            </div>
          </div>`;
        } else if (commentRefMatch) {
          bodyHTML += `<div class="group-comment-context">↩ Комментарий к посту</div>
            <div class="msg-text">${highlightMentions(linkifyText(commentRefMatch[2] || ''))}</div>`;
        } else {
        // Проверяем, является ли контент пересланным сообщением
        const fwd = parseForwardedMessage(msg.content);
        if (fwd) {
          let fwdAvatarHTML = '';
          if (fwd.isChannel) {
            fwdAvatarHTML = `<span class="fwd-mini-avatar" style="font-size:16px;">📢</span>`;
          } else {
            const fwdProfile = fwd.senderId ? allProfiles.find(p => p.id === fwd.senderId) : null;
            fwdAvatarHTML = fwdProfile
              ? `<span class="fwd-mini-avatar">${getContactAvatarHTML(fwdProfile, 18)}</span>`
              : `<span class="fwd-mini-avatar">↪</span>`;
          }
          const fwdLabel = fwd.isChannel
            ? `Переслано из канала <b>${escapeHTML(fwd.senderName)}</b>`
            : `Переслано от <b>${escapeHTML(fwd.senderName)}</b>`;
          bodyHTML += `
            <div class="forwarded-header">
              ${fwdAvatarHTML}
              <span class="forwarded-from-name">${fwdLabel}</span>
            </div>
            ${_renderLongText(fwd.text, msg.id + '-gfwd')}
          `;
        } else {
          if (msg.content && msg.content.length > MSG_COLLAPSE_LIMIT) {
            bodyHTML += _renderLongText(msg.content, msg.id + '-g');
          } else {
            bodyHTML += `<div class="msg-text">${highlightMentions(_applyTextFormatting(linkifyText(msg.content)))}</div>`;
          }
        }
        } // end else (not postRef/commentRef)
      }
    }
    if (msg.file_url) {
      const isImg = msg.file_type && msg.file_type.startsWith('image/');
      const isAudio = msg.file_type && (msg.file_type.startsWith('audio/') || (msg.file_name && (msg.file_name.endsWith('.mp3') || msg.file_name.endsWith('.ogg') || msg.file_name.endsWith('.webm') || msg.file_name.endsWith('.aac') || msg.file_name.endsWith('.flac') || msg.file_name.endsWith('.wav') || msg.file_name.endsWith('.m4a'))));
      const isVidNote = msg.file_name && msg.file_name.startsWith('vidnote_');
      if (isImg) {
        bodyHTML += `<img src="${msg.file_url}" class="msg-img" onclick="Chat.openImageModal('${msg.file_url}')" alt="изображение" style="max-width:240px;border-radius:10px;display:block;margin-top:4px;">`;
      } else if (isVidNote) {
        const uid = `vn-gm-${msg.id}`;
        bodyHTML += `
          <div class="vidnote-wrap" id="${uid}" style="margin-top:4px;">
            <div class="vidnote-clickable" onclick="Chat.toggleVidnote('${uid}')">
              <div class="vidnote-canvas-wrap">
                <video class="vidnote-video" id="${uid}-video" src="${escapeHTML(msg.file_url)}" preload="metadata" playsinline
                  onloadedmetadata="Chat.onVidnoteMetaLoaded('${uid}')"></video>
                <svg class="vidnote-ring-svg" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="48" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="2"/>
                  <circle cx="50" cy="50" r="48" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="2" stroke-linecap="round"
                    stroke-dasharray="301.6 301.6" stroke-dashoffset="301.6" id="${uid}-progress"
                    style="transform:rotate(-90deg);transform-origin:50% 50%;"/>
                </svg>
                <div class="vidnote-play-icon" id="${uid}-playicon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="6,3 20,12 6,21"/></svg>
                </div>
              </div>
            </div>
            <span class="vidnote-dur" id="${uid}-dur">Кружок</span>
          </div>`;
      } else if (isAudio) {
        const uid = `voice-gm-${msg.id}`;
        bodyHTML += `
          <div class="msg-voice">
            <button class="msg-voice-play" onclick="Chat.toggleMsgVoice('${uid}')" title="Воспроизвести">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" id="${uid}-icon"><polygon points="5,3 19,12 5,21"/></svg>
            </button>
            <div class="msg-voice-track">
              <input type="range" class="msg-voice-seek" id="${uid}-seek" min="0" max="100" value="0" step="0.1" oninput="Chat.seekMsgVoice('${uid}')">
              <div class="msg-voice-fill-bg"><div class="msg-voice-fill" id="${uid}-fill"></div></div>
            </div>
            <span class="msg-voice-dur" id="${uid}-dur">0:00</span>
            <audio id="${uid}-audio" src="${escapeHTML(msg.file_url)}" preload="metadata" style="display:none;"
              onloadedmetadata="Chat.onVoiceMetaLoaded('${uid}')"
              ontimeupdate="Chat.onVoiceTimeUpdate('${uid}')"
              onended="Chat.onVoiceEnded('${uid}')"></audio>
          </div>
          ${(!msg.file_name || msg.file_name.startsWith('voice_')) ? '' : `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">🎵 ${escapeHTML(msg.file_name)}</div>`}`;
      } else {
        bodyHTML += `<a class="msg-file" href="${escapeHTML(msg.file_url)}" target="_blank" rel="noopener">📎 ${escapeHTML(msg.file_name || 'файл')}</a>`;
      }
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'gm-wrapper' + (isMine ? ' gm-own' : ' gm-other') + (isFirstInSequence ? ' gm-first' : ' gm-cont');
    wrapper.dataset.msgId = msg.id;
    wrapper.dataset.senderId = msg.sender_id || '';

    // Плашка ответа
    const gmReplyPlateHTML = _buildReplyPlateHTML(msg);

    if (isMine) {
      // Своё: справа, без аватара и имени. Реакции — внутри пузыря
      wrapper.innerHTML = `
        <div class="gm-col gm-col-own">
          <div class="gm-bubble gm-bubble-own">
            ${gmReplyPlateHTML}
            ${bodyHTML}
            <div class="gm-meta"><span class="gm-time">${time}</span></div>
            ${buildReactionBar(msg.id, true)}
          </div>
        </div>`;
    } else {
      // Чужое: слева. Аватарка и имя — только на первом в цепочке
      const avatarHTML = isFirstInSequence
        ? `<div class="gm-avatar-wrap">${getContactAvatarHTML(sender, 34)}</div>`
        : `<div class="gm-avatar-spacer"></div>`;
      const nameHTML = isFirstInSequence
        ? `<div class="gm-sender-name">${escapeHTML(sender ? getContactDisplayName(sender) : senderName)}</div>`
        : '';
      wrapper.innerHTML = `
        ${avatarHTML}
        <div class="gm-col">
          ${nameHTML}
          <div class="gm-bubble gm-bubble-other">
            ${gmReplyPlateHTML}
            ${bodyHTML}
            <div class="gm-meta"><span class="gm-time">${time}</span></div>
            ${buildReactionBar(msg.id, false)}
          </div>
        </div>`;
    }

    // Контекстное меню и long-press для группового сообщения
    const bubble = wrapper.querySelector('.gm-bubble');
    if (bubble) {
      const textContent = msg.content || '';
      bubble.addEventListener('contextmenu', (e) => {
        showGroupMessageContextMenu(e, msg.id, isMine, textContent);
      });
      let longPressTimer = null;
      bubble.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
          showGroupMessageContextMenu(e.touches[0], msg.id, isMine, textContent);
        }, 500);
      }, { passive: true });
      bubble.addEventListener('touchend', () => { clearTimeout(longPressTimer); });
      bubble.addEventListener('touchmove', () => { clearTimeout(longPressTimer); });
    }

    container.appendChild(wrapper);
    // Apply twemoji to group message text
    wrapper.querySelectorAll('.msg-text').forEach(el => _applyTwemoji(el));
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    if (atBottom) container.scrollTop = container.scrollHeight;
  }

  // ---- Контекстное меню для сообщений в группе ----
  function showGroupMessageContextMenu(e, msgId, isMine, textContent) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.msg-context-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'msg-context-menu';
    // Определяем, закреплено ли уже это сообщение в группе
    const grpPinKey = buildPinKey();
    let grpIsPinned = false;
    if (grpPinKey) {
      try {
        const grpPinData = JSON.parse(localStorage.getItem(grpPinKey) || 'null');
        grpIsPinned = !!(grpPinData && grpPinData.msgId === msgId);
      } catch (_) {}
    }
    const grpPinBtnHTML = grpIsPinned
      ? `<button class="msg-ctx-item" data-action="unpin">📌 Открепить</button>`
      : `<button class="msg-ctx-item" data-action="pin">📌 Закрепить</button>`;

    // Проверяем выделенный текст для цитаты
    const grpSelection = window.getSelection();
    const grpHasSelection = grpSelection && grpSelection.toString().trim().length > 0;
    const grpQuoteBtn = grpHasSelection
      ? `<button class="msg-ctx-item" data-action="quote-reply">❝ Ответить с цитатой</button>`
      : '';

    if (isMine) {
      menu.innerHTML = `
        <button class="msg-ctx-item" data-action="reply">↩ Ответить</button>
        ${grpQuoteBtn}
        ${grpPinBtnHTML}
        <button class="msg-ctx-item" data-action="select">✓ Выделить</button>
        <button class="msg-ctx-item" data-action="copy">📋 Копировать</button>
        <button class="msg-ctx-item" data-action="forward">↪️ Переслать</button>
        <button class="msg-ctx-item" data-action="delete-me">🙈 Удалить у себя</button>
        <button class="msg-ctx-item msg-ctx-item--danger" data-action="delete-all">🗑️ Удалить для всех</button>
      `;
    } else {
      menu.innerHTML = `
        <button class="msg-ctx-item" data-action="reply">↩ Ответить</button>
        ${grpQuoteBtn}
        ${grpPinBtnHTML}
        <button class="msg-ctx-item" data-action="select">✓ Выделить</button>
        <button class="msg-ctx-item" data-action="copy">📋 Копировать</button>
        <button class="msg-ctx-item" data-action="forward">↪️ Переслать</button>
        <button class="msg-ctx-item" data-action="delete-me">🙈 Удалить у себя</button>
      `;
    }

    const grpSelectedQuoteText = grpHasSelection ? grpSelection.toString().trim() : '';

    document.body.appendChild(menu);

    menu.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        menu.remove();
        if (action === 'reply') {
          // Ответить на сообщение в группе
          const msgWrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
          const senderId = msgWrapper ? msgWrapper.dataset.senderId : null;
          const senderProfile = senderId ? allProfiles.find(p => p.id === senderId) : null;
          const sName = isMine ? 'Вы' : (senderProfile ? getDisplayName(senderProfile) : 'Участник');
          const sAvatar = isMine ? currentUser.avatar_url : (senderProfile ? senderProfile.avatar_url : null);
          startReply(msgId, sName, sAvatar, textContent);
        } else if (action === 'quote-reply') {
          const msgWrapper = document.querySelector(`[data-msg-id="${msgId}"]`);
          const senderId = msgWrapper ? msgWrapper.dataset.senderId : null;
          const senderProfile = senderId ? allProfiles.find(p => p.id === senderId) : null;
          const sName = isMine ? 'Вы' : (senderProfile ? getDisplayName(senderProfile) : 'Участник');
          const sAvatar = isMine ? currentUser.avatar_url : (senderProfile ? senderProfile.avatar_url : null);
          startReplyWithQuote(msgId, sName, sAvatar, grpSelectedQuoteText);
        } else if (action === 'pin') {
          pinMessage(msgId, textContent);
        } else if (action === 'unpin') {
          unpinMessage();
        } else if (action === 'select') {
          enterSelectionMode(msgId);
        } else if (action === 'copy') {
          if (textContent) navigator.clipboard.writeText(textContent)
            .then(() => showToast('Скопировано', 'success'))
            .catch(() => {});
        } else if (action === 'forward') {
          openForwardModal(msgId, textContent);
        } else if (action === 'delete-me') {
          deleteMessageForMe(msgId);
        } else if (action === 'delete-all') {
          deleteGroupMessageForAll(msgId);
        }
      });
    });

    let x = e.clientX, y = e.clientY;
    menu.style.left = '0px'; menu.style.top = '-9999px';
    requestAnimationFrame(() => {
      const mh = menu.offsetHeight, mw = menu.offsetWidth;
      const vw = window.innerWidth, vh = window.innerHeight;
      if (x + mw > vw) x = vw - mw - 8;
      if (x < 8) x = 8;
      if (y + mh > vh) y = y - mh - 8;
      if (y < 8) y = 8;
      if (_isMobile && mw > vw - 24) {
        x = 12;
        menu.style.width = (vw - 24) + 'px';
      }
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
    });

    const close = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); document.removeEventListener('touchstart', close); }
    };
    setTimeout(() => {
      document.addEventListener('click', close);
      document.addEventListener('touchstart', close, { passive: true });
    }, 10);
  }

  // ---- Удалить групповое сообщение для всех ----
  async function deleteGroupMessageForAll(msgId) {
    try {
      // Читаем запись для получения URL файла (если был)
      const { data: msgData } = await window.supabaseClient
        .from('group_messages')
        .select('file_url')
        .eq('id', msgId)
        .eq('sender_id', currentUser.id)
        .maybeSingle();

      const { error } = await window.supabaseClient
        .from('group_messages')
        .delete()
        .eq('id', msgId)
        .eq('sender_id', currentUser.id);
      if (!error) {
        const el = document.querySelector('[data-msg-id="' + msgId + '"]');
        if (el) el.remove();
        renderedMessageIds.delete(msgId);
        // Удаляем прикреплённый файл из хранилища
        if (msgData?.file_url) await _deleteStorageFile(msgData.file_url);
      } else {
        showToast('Не удалось удалить', 'error');
        console.error('deleteGroupMessageForAll error:', error);
      }
    } catch (err) {
      showToast('Ошибка при удалении', 'error');
      console.error(err);
    }
  }

  // ---- Отправить сообщение в группу ----
  async function sendGroupMessage() {
    if (!selectedGroup || !currentUser) return;
    const input = getEl('message-input');
    if (!input) return;
    const content = input.value.trim();
    const grpFiles = selectedFiles.length > 0 ? [...selectedFiles] : (selectedFile ? [selectedFile] : []);
    if (!content && grpFiles.length === 0) return;

    // Проверка мута на сервере
    try {
      const { data: memberRow, error: muteErr } = await window.supabaseClient
        .from('group_members')
        .select('muted')
        .eq('group_id', selectedGroup.id)
        .eq('user_id', currentUser.id)
        .maybeSingle();
      if (!muteErr && memberRow && memberRow.muted) {
        showToast('Вы замучены в этой группе. Обратитесь к администратору.', 'error');
        return;
      }
    } catch (e) { /* если поля нет — продолжаем */ }

    // Антифлуд-проверка (глобальная, общая с личными чатами)
    if (!checkFlood()) return;

    // Очищаем черновик группы при отправке
    clearDraftForCurrentChat();
    const sentContent = input.value.trim();
    input.value = '';
    input.style.height = '';
    clearSelectedFile();
    getEl('send-btn').style.display = 'none';
    getEl('mic-btn').style.display = '';

    try {
      if (grpFiles.length > 0) {
        showUploadIndicator();
        const successUploads = [];
        for (let f of grpFiles) {
          f = await compressImageFile(f);
          if (f.size > MAX_FILE_SIZE) { showToast(`${f.name}: файл слишком большой`, 'error'); continue; }
          const ext = f.name.split('.').pop();
          const filePath = `group_files/${selectedGroup.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
          const { error: upErr } = await window.supabaseClient.storage
            .from('chat-files').upload(filePath, f, { cacheControl: '3600', upsert: false });
          if (upErr) { showToast('Ошибка загрузки: ' + upErr.message, 'error'); continue; }
          const { data: { publicUrl } } = window.supabaseClient.storage.from('chat-files').getPublicUrl(filePath);
          successUploads.push({ publicUrl, f });
        }
        hideUploadIndicator();
        for (let i = 0; i < successUploads.length; i++) {
          const { publicUrl, f } = successUploads[i];
          const isLast = i === successUploads.length - 1;
          await window.supabaseClient.from('group_messages').insert({
            group_id: selectedGroup.id,
            sender_id: currentUser.id,
            content: isLast && sentContent ? sentContent : null,
            file_url: publicUrl, file_name: f.name, file_type: f.type, file_size: f.size
          });
        }
        return;
      }
      // Текст без файла
      const grpReplyData = _getReplyData();
      cancelReply();
      const grpInsert = {
        group_id: selectedGroup.id,
        sender_id: currentUser.id,
        content: sentContent || null,
      };
      if (grpReplyData) {
        grpInsert.reply_to = grpReplyData.reply_to;
        grpInsert.reply_text = grpReplyData.reply_text;
        grpInsert.quote_text = grpReplyData.quote_text;
      }
      await window.supabaseClient.from('group_messages').insert(grpInsert);
    } catch (e) {
      showToast('Ошибка отправки', 'error');
    }
  }

  // ---- Модальное окно: создать группу ----
  function openCreateGroupModal() {
    groupSelectedMembers = [];
    const modal = getEl('create-group-modal');
    if (modal) modal.style.display = 'flex';
    const nameInput = getEl('group-name-input');
    if (nameInput) { nameInput.value = ''; nameInput.focus(); }
    const searchInput = getEl('group-member-search');
    if (searchInput) searchInput.value = '';
    renderGroupMemberResults('');
    renderGroupSelectedChips();
  }

  function closeCreateGroupModal() {
    const modal = getEl('create-group-modal');
    if (modal) modal.style.display = 'none';
  }

  function renderGroupMemberResults(query) {
    const el = getEl('group-member-results');
    if (!el) return;
    const q = query.toLowerCase();
    const filtered = allProfiles.filter(p =>
      p.id !== currentUser.id &&
      !isBot(p) &&                                        // нельзя добавить бота
      isMutualContact(p.id) &&                            // только взаимные контакты
      !groupSelectedMembers.find(m => m.id === p.id) &&
      (getDisplayName(p).toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
    ).slice(0, 8);

    if (filtered.length === 0) {
      el.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:6px 0;">Нет взаимных контактов для добавления</div>`;
      return;
    }
    el.innerHTML = filtered.map(p => `
      <div class="group-member-row" onclick="Chat.addGroupMember('${p.id}')">
        ${getAvatarHTML(p, 32)}
        <span class="gm-name">${escapeHTML(getDisplayName(p))}</span>
        <span class="gm-add-icon">+</span>
      </div>
    `).join('');
  }

  function addGroupMember(userId) {
    const profile = allProfiles.find(p => p.id === userId);
    if (!profile || groupSelectedMembers.find(m => m.id === userId)) return;
    groupSelectedMembers.push(profile);
    renderGroupSelectedChips();
    const searchInput = getEl('group-member-search');
    renderGroupMemberResults(searchInput ? searchInput.value : '');
  }

  function removeGroupMember(userId) {
    groupSelectedMembers = groupSelectedMembers.filter(m => m.id !== userId);
    renderGroupSelectedChips();
    const searchInput = getEl('group-member-search');
    renderGroupMemberResults(searchInput ? searchInput.value : '');
  }

  function renderGroupSelectedChips() {
    const el = getEl('group-selected-members');
    if (!el) return;
    el.innerHTML = groupSelectedMembers.map(p => `
      <div class="gm-chip">
        ${escapeHTML(getDisplayName(p))}
        <button class="gm-chip-remove" onclick="Chat.removeGroupMember('${p.id}')" title="Убрать">×</button>
      </div>
    `).join('');
  }

  async function confirmCreateGroup() {
    const nameInput = getEl('group-name-input');
    const confirmBtn = getEl('confirm-create-group-btn');
    if (!nameInput) return;
    const name = nameInput.value.trim();
    if (!name) { showToast('Введите название группы', 'error'); return; }

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Создаём...';
    try {
      const memberIds = groupSelectedMembers.map(m => m.id);
      const { data: groupId, error } = await window.supabaseClient
        .rpc('create_group', { p_name: name, p_member_ids: memberIds });
      if (error) throw error;
      showToast(`Группа «${name}» создана!`, 'success');
      closeCreateGroupModal();
      await loadGroups();
      // Открываем созданную группу
      const newGroup = groups.find(g => g.id === groupId);
      if (newGroup) openGroupChat(newGroup);
    } catch (e) {
      showToast('Ошибка создания группы', 'error');
      console.error(e);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Создать группу';
    }
  }

  // ============================================================
  // ---- Инфо-панель группы ----
  // ============================================================

  function openGroupInfo() {
    if (!selectedGroup) return;
    const panel = getEl('group-info-panel');
    if (!panel) return;
    renderGroupInfoPanel();
    panel.classList.add('open');
    // Сброс активного таба медиа и загрузка
    document.querySelectorAll('.gip-media-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
    _loadGroupMedia('photo');
  }

  function closeGroupInfo() {
    const panel = getEl('group-info-panel');
    if (panel) panel.classList.remove('open');
  }

  function renderGroupInfoPanel() {
    if (!selectedGroup || !currentUser) return;
    const cache = groupMembersCache[selectedGroup.id] || { members: [], profiles: [] };
    const members = cache.members;    // { user_id, role }
    const profiles = cache.profiles;  // profile объекты
    const isAdmin = members.some(m => m.user_id === currentUser.id && m.role === 'admin')
      || selectedGroup.created_by === currentUser.id;

    // Имя и аватарка группы
    const nameEl = getEl('gip-group-name');
    const avatarEl = getEl('gip-group-avatar');
    if (nameEl) {
      const grpVerBadge = (window.IFlashSub && window.IFlashSub.isVerifiedGroup(selectedGroup.id)) ? window.IFlashSub.verifiedBadgeHTML() : '';
      nameEl.style.display = 'flex';
      nameEl.style.alignItems = 'center';
      nameEl.style.gap = '4px';
      nameEl.innerHTML = escapeHTML(selectedGroup.name) + grpVerBadge;
    }
    if (avatarEl) {
      const _avatarInner = selectedGroup.avatar_url
        ? `<img src="${selectedGroup.avatar_url}" style="width:72px;height:72px;border-radius:20px;object-fit:cover;display:block;" alt="group">`
        : `<div class="conv-group-avatar" style="width:72px;height:72px;border-radius:20px;font-size:28px;">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="7" r="3"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0-3-3.85"/></svg>
          </div>`;
      if (isAdmin) {
        // Для админа — аватарка кликабельна, при наведении показывается иконка камеры
        avatarEl.innerHTML = `
          <div onclick="Chat.groupChangeAvatarStart()" title="Сменить аватарку"
               style="position:relative;cursor:pointer;display:inline-block;border-radius:20px;overflow:hidden;">
            ${_avatarInner}
            <div class="gip-avatar-cam-overlay"
                 style="position:absolute;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.18s;border-radius:20px;"
                 onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0'">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            </div>
          </div>`;
      } else {
        avatarEl.innerHTML = _avatarInner;
      }
    }

    // Кнопки редактирования для админа
    const editBtns = getEl('gip-edit-btns');
    if (editBtns) {
      if (isAdmin) {
        editBtns.innerHTML = `
          <button class="gip-edit-btn" onclick="Chat.groupRenameModal()">✏️ Переименовать</button>
          <button class="gip-edit-btn" onclick="Chat.groupChangeAvatarStart()">📷 Сменить аватарку</button>
          <button class="gip-edit-btn gip-edit-btn--danger" onclick="Chat.showDeleteGroupConfirm('${selectedGroup.id}')">🗑️ Удалить группу</button>
        `;
      } else {
        editBtns.innerHTML = `
          <button class="gip-edit-btn gip-edit-btn--danger" onclick="Chat.leaveGroupFromPanel('${selectedGroup.id}')">🚪 Выйти из группы</button>
        `;
      }
    }

    // Список участников
    const listEl = getEl('gip-members-list');
    if (!listEl) return;
    listEl.innerHTML = members.map(m => {
      const profile = profiles.find(p => p.id === m.user_id) || allProfiles.find(p => p.id === m.user_id);
      if (!profile) return '';
      const nick = getDisplayName(profile);
      const role = m.role === 'admin' || m.user_id === selectedGroup.created_by ? 'admin' : 'member';
      const isMuted = m.muted === true;
      const roleLabel = role === 'admin' ? '<span class="gip-role-badge">Админ</span>' : '';
      const mutedLabel = isMuted ? '<span class="gip-muted-badge">🔇 Замучен</span>' : '';
      const isMe = m.user_id === currentUser.id;
      const actionsHTML = (isAdmin && !isMe) ? `
        <button class="gip-member-action-btn" onclick="event.stopPropagation(); Chat.groupMemberActions('${m.user_id}', '${escapeHTML(nick)}', '${role}', event)">•••</button>
      ` : '';
      return `
        <div class="gip-member-row" data-uid="${m.user_id}" onclick="Chat.showUserProfile('${m.user_id}')" style="cursor:pointer;">
          <div class="gip-member-avatar">${getAvatarHTML(profile, 38)}</div>
          <div class="gip-member-info">
            <span class="gip-member-nick">${escapeHTML(nick)}${isMe ? ' <span class="gip-you">(Вы)</span>' : ''}</span>
            ${roleLabel}${mutedLabel}
          </div>
          ${actionsHTML}
        </div>`;
    }).join('');
  }

  // Меню действий над участником (кик / мут / назначить админом)
  function groupMemberActions(userId, nick, currentRole, ev) {
    // Создаём временный попап
    const existingPopup = document.getElementById('gm-action-popup');
    if (existingPopup) existingPopup.remove();

    const popup = document.createElement('div');
    popup.id = 'gm-action-popup';
    popup.className = 'gm-action-popup';
    const isAdmin = currentRole === 'admin';
    popup.innerHTML = `
      <div class="gm-action-header">
        <span>${escapeHTML(nick)}</span>
        <button class="gm-action-close" onclick="document.getElementById('gm-action-popup').remove()">✕</button>
      </div>
      ${isAdmin ? '' : `<button class="gm-action-item gm-action-promote" onclick="Chat.groupPromoteAdmin('${userId}', '${escapeHTML(nick)}')">⭐ Назначить админом</button>`}
      <button class="gm-action-item gm-action-mute" onclick="Chat.groupMuteUser('${userId}', '${escapeHTML(nick)}')">🔇 Замутить</button>
      <button class="gm-action-item gm-action-unmute" onclick="Chat.groupUnmuteUser('${userId}', '${escapeHTML(nick)}')">🔊 Снять мут</button>
      <button class="gm-action-item gm-action-kick" onclick="Chat.groupKickMember('${userId}', '${escapeHTML(nick)}')">🚫 Исключить</button>
    `;
    document.body.appendChild(popup);

    // Позиционируем рядом с кнопкой ••• (не по центру)
    if (ev && ev.target) {
      const rect = ev.target.closest('.gip-member-action-btn')?.getBoundingClientRect() || ev.target.getBoundingClientRect();
      popup.style.left = '0'; popup.style.top = '-9999px';
      requestAnimationFrame(() => {
        const ph = popup.offsetHeight, pw = popup.offsetWidth;
        let x = rect.right - pw;
        let y = rect.bottom + 4;
        if (x < 8) x = 8;
        if (y + ph > window.innerHeight - 8) y = rect.top - ph - 4;
        if (x + pw > window.innerWidth - 8) x = window.innerWidth - pw - 8;
        popup.style.left = x + 'px';
        popup.style.top = y + 'px';
      });
    } else {
      popup.style.top = '50%'; popup.style.left = '50%'; popup.style.transform = 'translate(-50%,-50%)';
    }

    // Клик вне попапа — закрыть
    setTimeout(() => {
      document.addEventListener('click', function handler(e) {
        if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', handler); }
      });
    }, 50);
  }

  async function groupKickMember(userId, nick) {
    document.getElementById('gm-action-popup')?.remove();
    if (!selectedGroup || !currentUser) return;
    if (!confirm(`Исключить ${nick} из группы?`)) return;
    try {
      const { error } = await window.supabaseClient
        .from('group_members')
        .delete()
        .eq('group_id', selectedGroup.id)
        .eq('user_id', userId);
      if (error) throw error;
      showToast(`${nick} исключён из группы`, 'success');
      // Обновить кеш
      if (groupMembersCache[selectedGroup.id]) {
        groupMembersCache[selectedGroup.id].members = groupMembersCache[selectedGroup.id].members.filter(m => m.user_id !== userId);
        groupMembersCache[selectedGroup.id].profiles = groupMembersCache[selectedGroup.id].profiles.filter(p => p.id !== userId);
      }
      renderGroupInfoPanel();
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function groupMuteUser(userId, nick) {
    document.getElementById('gm-action-popup')?.remove();
    if (!selectedGroup) return;
    try {
      const { error } = await window.supabaseClient
        .from('group_members')
        .update({ muted: true })
        .eq('group_id', selectedGroup.id)
        .eq('user_id', userId);
      if (error) throw error;
      showToast(`${nick} замучен в группе`, 'success');
      // Обновить кеш
      if (groupMembersCache[selectedGroup.id]) {
        const m = groupMembersCache[selectedGroup.id].members.find(x => x.user_id === userId);
        if (m) m.muted = true;
      }
      renderGroupInfoPanel();
    } catch (e) {
      showToast('Ошибка: ' + (e.message || 'не удалось замутить'), 'error');
    }
  }

  async function groupUnmuteUser(userId, nick) {
    document.getElementById('gm-action-popup')?.remove();
    if (!selectedGroup) return;
    try {
      const { error } = await window.supabaseClient
        .from('group_members')
        .update({ muted: false })
        .eq('group_id', selectedGroup.id)
        .eq('user_id', userId);
      if (error) throw error;
      showToast(`Мут снят с ${nick}`, 'success');
      // Обновить кеш
      if (groupMembersCache[selectedGroup.id]) {
        const m = groupMembersCache[selectedGroup.id].members.find(x => x.user_id === userId);
        if (m) m.muted = false;
      }
      renderGroupInfoPanel();
    } catch (e) {
      showToast('Ошибка: ' + (e.message || 'не удалось снять мут'), 'error');
    }
  }

  async function groupPromoteAdmin(userId, nick) {
    document.getElementById('gm-action-popup')?.remove();
    if (!selectedGroup) return;
    try {
      const { error } = await window.supabaseClient
        .from('group_members')
        .update({ role: 'admin' })
        .eq('group_id', selectedGroup.id)
        .eq('user_id', userId);
      if (error) throw error;
      showToast(`${nick} теперь админ!`, 'success');
      // Обновить кеш
      if (groupMembersCache[selectedGroup.id]) {
        const m = groupMembersCache[selectedGroup.id].members.find(x => x.user_id === userId);
        if (m) m.role = 'admin';
      }
      renderGroupInfoPanel();
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  function groupRenameModal() {
    closeGroupInfo();
    const newName = prompt('Новое название группы:', selectedGroup?.name || '');
    if (!newName || !newName.trim() || !selectedGroup) return;
    groupRename(newName.trim());
  }

  async function groupRename(newName) {
    if (!selectedGroup) return;
    try {
      const { error } = await window.supabaseClient
        .from('groups')
        .update({ name: newName })
        .eq('id', selectedGroup.id);
      if (error) throw error;
      selectedGroup = { ...selectedGroup, name: newName };
      // Обновить в списке groups
      const idx = groups.findIndex(g => g.id === selectedGroup.id);
      if (idx !== -1) groups[idx] = selectedGroup;
      // Сразу обновляем элемент в сайдбаре (без полного перерендера)
      const sidebarNameEl = document.querySelector(`.conversation-item[data-group-id="${selectedGroup.id}"] .conv-name`);
      if (sidebarNameEl) sidebarNameEl.textContent = newName;
      showToast('Название обновлено', 'success');
      // Перерисовать шапку — переоткроем чат
      await openGroupChat(selectedGroup);
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  // Смена аватарки группы — с кроппером
  function groupChangeAvatarStart() {
    // Не закрываем панель — кроппер откроется поверх
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      openAvatarCropper(file, async (croppedBlob) => {
        await uploadGroupAvatar(croppedBlob);
      });
    };
    input.click();
  }

  async function uploadGroupAvatar(blob) {
    if (!selectedGroup || !currentUser) return;
    try {
      // Используем уникальный путь с timestamp — обходим RLS на update существующего файла
      const ts = Date.now();
      const path = `group_avatars/${selectedGroup.id}_${ts}.jpg`;

      // Сначала пробуем удалить старый файл (игнорируем ошибку если нет)
      const oldUrl = selectedGroup.avatar_url;
      if (oldUrl) {
        const oldMatch = oldUrl.match(/group_avatars\/[^?]+/);
        if (oldMatch) {
          await window.supabaseClient.storage.from('chat-files').remove([oldMatch[0]]).catch(() => {});
        }
      }

      // Загружаем новый файл
      const { error: upErr } = await window.supabaseClient.storage
        .from('chat-files')
        .upload(path, blob, { contentType: 'image/jpeg' });
      if (upErr) {
        console.error('[GroupAvatar] upload error:', upErr);
        throw new Error('Ошибка загрузки файла: ' + upErr.message);
      }

      const { data: urlData } = window.supabaseClient.storage.from('chat-files').getPublicUrl(path);
      const avatarUrl = urlData.publicUrl + '?t=' + ts;

      const { data: updatedRows, error: dbErr } = await window.supabaseClient
        .from('groups')
        .update({ avatar_url: avatarUrl })
        .eq('id', selectedGroup.id)
        .select();
      if (dbErr) {
        console.error('[GroupAvatar] db update error:', dbErr);
        throw new Error('Ошибка обновления БД: ' + dbErr.message);
      }
      // Если RLS заблокировал UPDATE — Supabase не вернёт строк, но и ошибки не даст
      if (!updatedRows || updatedRows.length === 0) {
        throw new Error('Нет прав на обновление группы. Проверьте RLS-политики для таблицы groups (UPDATE для admin/owner).');
      }

      selectedGroup = { ...selectedGroup, avatar_url: avatarUrl };
      const idx = groups.findIndex(g => g.id === selectedGroup.id);
      if (idx !== -1) groups[idx] = selectedGroup;
      showToast('Аватарка группы обновлена!', 'success');

      // 1. Обновляем аватарку в шапке чата напрямую (без перезагрузки сообщений)
      const headerContent = getEl('chat-header-content');
      if (headerContent) {
        const oldAvatarEl = headerContent.querySelector('.chat-header-user img[alt="group"], .chat-header-user .conv-group-avatar');
        if (oldAvatarEl) {
          const newImg = document.createElement('img');
          newImg.src = avatarUrl;
          newImg.setAttribute('style', 'width:40px;height:40px;border-radius:13px;object-fit:cover;flex-shrink:0;');
          newImg.alt = 'group';
          oldAvatarEl.replaceWith(newImg);
        }
      }

      // 2. Перерисовываем список диалогов — обновляет аватарку в сайдбаре
      // и пересоздаёт onclick-замыкания с новым объектом group (исправляет сброс аватарки при клике)
      renderConversations();

      // 3. Обновляем инфо-панель (если открыта) с новой аватаркой
      const gipPanel = getEl('group-info-panel');
      if (gipPanel && gipPanel.classList.contains('open')) {
        renderGroupInfoPanel();
      }
    } catch (e) {
      console.error('[GroupAvatar] exception:', e);
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  // ============================================================
  // ---- Кроппер аватарки (для группы и аккаунта) ----
  // ============================================================

  let cropperCanvas = null;
  let cropperCtx = null;
  let cropperImg = null;
  let cropperCallback = null;
  let cropState = { x: 0, y: 0, size: 200, dragging: false, resizing: false, startX: 0, startY: 0, startSize: 0 };

  function openAvatarCropper(file, callback) {
    cropperCallback = callback;
    const modal = getEl('avatar-cropper-modal');
    if (!modal) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        cropperImg = img;
        initCropperCanvas(img);
        modal.style.display = 'flex';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function closeAvatarCropper() {
    const modal = getEl('avatar-cropper-modal');
    if (modal) modal.style.display = 'none';
    cropperCallback = null;
    cropperImg = null;
  }

  function initCropperCanvas(img) {
    const canvas = getEl('cropper-canvas');
    if (!canvas) return;
    cropperCanvas = canvas;
    cropperCtx = canvas.getContext('2d');

    // Масштабируем под canvas
    const maxW = Math.min(window.innerWidth - 60, 500);
    const maxH = Math.min(window.innerHeight - 220, 400);
    let scale = Math.min(maxW / img.width, maxH / img.height, 1);
    canvas.width = Math.floor(img.width * scale);
    canvas.height = Math.floor(img.height * scale);

    // Начальный квадрат кропа — по центру, 60% меньшей стороны
    const minDim = Math.min(canvas.width, canvas.height);
    cropState.size = Math.floor(minDim * 0.7);
    cropState.x = Math.floor((canvas.width - cropState.size) / 2);
    cropState.y = Math.floor((canvas.height - cropState.size) / 2);

    drawCropper();

    // Мышь/тач события
    canvas.onmousedown = cropperMouseDown;
    canvas.onmousemove = cropperMouseMove;
    canvas.onmouseup = cropperMouseUp;
    canvas.ontouchstart = (e) => { e.preventDefault(); cropperMouseDown(e.touches[0]); };
    canvas.ontouchmove = (e) => { e.preventDefault(); cropperMouseMove(e.touches[0]); };
    canvas.ontouchend = (e) => { cropperMouseUp(e); };
  }

  function drawCropper() {
    if (!cropperCtx || !cropperImg || !cropperCanvas) return;
    const { x, y, size } = cropState;
    const cw = cropperCanvas.width, ch = cropperCanvas.height;
    cropperCtx.clearRect(0, 0, cw, ch);
    // Рисуем изображение
    cropperCtx.drawImage(cropperImg, 0, 0, cw, ch);
    // Затемнение вне кропа
    cropperCtx.fillStyle = 'rgba(0,0,0,0.55)';
    cropperCtx.fillRect(0, 0, cw, ch);
    // Вырезаем светлый круг (или квадрат)
    cropperCtx.save();
    cropperCtx.globalCompositeOperation = 'destination-out';
    cropperCtx.beginPath();
    cropperCtx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    cropperCtx.fill();
    cropperCtx.restore();
    // Рисуем изображение внутри круга (без затемнения)
    cropperCtx.save();
    cropperCtx.beginPath();
    cropperCtx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    cropperCtx.clip();
    cropperCtx.drawImage(cropperImg, 0, 0, cw, ch);
    cropperCtx.restore();
    // Рамка кружка
    cropperCtx.strokeStyle = '#fff';
    cropperCtx.lineWidth = 2;
    cropperCtx.beginPath();
    cropperCtx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    cropperCtx.stroke();
    // Ручка для ресайза (нижний правый угол)
    cropperCtx.fillStyle = '#fff';
    cropperCtx.beginPath();
    cropperCtx.arc(x + size, y + size, 8, 0, Math.PI * 2);
    cropperCtx.fill();
  }

  function cropperMouseDown(e) {
    const rect = cropperCanvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (cropperCanvas.width / rect.width);
    const cy = (e.clientY - rect.top) * (cropperCanvas.height / rect.height);
    const { x, y, size } = cropState;
    // Ресайз: клик рядом с правым нижним углом
    const dResize = Math.hypot(cx - (x + size), cy - (y + size));
    if (dResize < 16) {
      cropState.resizing = true;
      cropState.startX = cx; cropState.startY = cy; cropState.startSize = size;
      return;
    }
    // Перетаскивание: клик внутри круга
    const dx = cx - (x + size / 2), dy = cy - (y + size / 2);
    if (Math.hypot(dx, dy) < size / 2) {
      cropState.dragging = true;
      cropState.startX = cx - x; cropState.startY = cy - y;
    }
  }

  function cropperMouseMove(e) {
    if (!cropState.dragging && !cropState.resizing) return;
    const rect = cropperCanvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (cropperCanvas.width / rect.width);
    const cy = (e.clientY - rect.top) * (cropperCanvas.height / rect.height);
    const cw = cropperCanvas.width, ch = cropperCanvas.height;

    if (cropState.resizing) {
      const dx = cx - cropState.startX, dy = cy - cropState.startY;
      const delta = (Math.abs(dx) > Math.abs(dy)) ? dx : dy;
      let newSize = Math.max(60, Math.min(cropState.startSize + delta, Math.min(cw, ch)));
      cropState.size = newSize;
      // Не выходим за границы
      cropState.x = Math.max(0, Math.min(cropState.x, cw - newSize));
      cropState.y = Math.max(0, Math.min(cropState.y, ch - newSize));
    } else {
      cropState.x = Math.max(0, Math.min(cx - cropState.startX, cw - cropState.size));
      cropState.y = Math.max(0, Math.min(cy - cropState.startY, ch - cropState.size));
    }
    drawCropper();
  }

  function cropperMouseUp() {
    cropState.dragging = false;
    cropState.resizing = false;
  }

  async function applyCrop() {
    if (!cropperImg || !cropperCanvas) return;
    const { x, y, size } = cropState;
    // Масштаб canvas → оригинал
    const scaleX = cropperImg.width / cropperCanvas.width;
    const scaleY = cropperImg.height / cropperCanvas.height;
    const srcX = x * scaleX, srcY = y * scaleY, srcSize = size * scaleX;

    // Рисуем кроп на временном canvas
    const out = document.createElement('canvas');
    out.width = 256; out.height = 256;
    const ctx = out.getContext('2d');
    // НЕ применяем круговой клип — JPEG не поддерживает прозрачность,
    // прозрачные углы становятся чёрными. Форма круга/скруглений делается через CSS.
    ctx.drawImage(cropperImg, srcX, srcY, srcSize, srcSize, 0, 0, 256, 256);

    const modal = getEl('avatar-cropper-modal');
    if (modal) modal.style.display = 'none';

    out.toBlob(async (blob) => {
      if (cropperCallback) {
        // Дополнительно сжимаем через библиотеку для минимального размера
        const compressedBlob = await compressImage(
          new File([blob], 'avatar.jpg', { type: 'image/jpeg' }),
          { maxSizeMB: 0.08, maxWidthOrHeight: 256, initialQuality: 0.78, fileType: 'image/jpeg' }
        );
        await cropperCallback(compressedBlob);
        cropperCallback = null;
      }
    }, 'image/jpeg', 0.85);
  }

  // Кроппер для аватарки аккаунта (вызывается из настроек)
  function startAccountAvatarCrop(file) {
    openAvatarCropper(file, async (blob) => {
      await uploadAccountAvatar(blob);
    });
  }

  async function uploadAccountAvatar(blob) {
    if (!currentUser) return;
    try {
      const path = `avatars/${currentUser.id}.jpg`;
      const { error: upErr } = await window.supabaseClient.storage
        .from('chat-files')
        .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
      if (upErr) throw upErr;
      const { data: { publicUrl } } = window.supabaseClient.storage.from('chat-files').getPublicUrl(path);
      const { error: dbErr } = await window.supabaseClient
        .from('profiles')
        .update({ avatar_url: publicUrl })
        .eq('id', currentUser.id);
      if (dbErr) throw dbErr;
      if (currentProfile) currentProfile.avatar_url = publicUrl;
      showToast('Аватарка обновлена!', 'success');
      // Обновить аватар в шапке настроек
      const settingsAvatar = document.querySelector('.settings-avatar');
      if (settingsAvatar) {
        settingsAvatar.innerHTML = getAvatarHTML(currentProfile, 72);
      }
    } catch (e) {
      showToast('Ошибка загрузки: ' + e.message, 'error');
    }
  }

  // ============================================================
  // ---- Пригласительные ссылки для групп ----
  // ============================================================

  // Генерируем invite-ссылку для группы и отправляем в чат
  async function generateGroupInviteLink() {
    if (!selectedGroup || !currentUser) return;

    // Проверяем, является ли пользователь членом группы
    const cache = groupMembersCache[selectedGroup.id] || {};
    const members = cache.members || [];
    const isMember = members.some(m => m.user_id === currentUser.id);
    if (!isMember) {
      showToast('Вы не состоите в этой группе', 'error');
      return;
    }

    const inviteCode = 'IFlashGROUP_' + selectedGroup.id;
    const input = getEl('message-input');
    if (input) {
      input.value = inviteCode;
      input.dispatchEvent(new Event('input'));
      input.focus();
      showToast('Ссылка-приглашение вставлена в поле ввода', 'success');
    }
  }

  // Обрабатываем клик по пригласительной ссылке в чате
  async function handleGroupInviteClick(groupId) {
    if (!currentUser) return;

    // Загружаем инфо о группе
    try {
      const { data: group, error } = await window.supabaseClient
        .from('groups')
        .select('*')
        .eq('id', groupId)
        .maybeSingle();

      if (error || !group) {
        showToast('Группа не найдена или ссылка недействительна', 'error');
        return;
      }

      // Считаем участников
      const { count } = await window.supabaseClient
        .from('group_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('group_id', groupId);

      // Показываем модальное окно вступления
      showGroupJoinModal(group, count || 0);
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  function showGroupJoinModal(group, memberCount) {
    // Удаляем старое модальное окно, если есть
    const existing = document.getElementById('group-join-modal');
    if (existing) existing.remove();

    const countWord = memberCount === 1 ? 'участник' : memberCount < 5 ? 'участника' : 'участников';
    const avatarHTML = group.avatar_url
      ? `<img src="${group.avatar_url}" class="gjm-avatar-img" alt="group">`
      : `<div class="gjm-avatar-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="7" r="3"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0-3-3.85"/></svg></div>`;

    const modal = document.createElement('div');
    modal.id = 'group-join-modal';
    modal.className = 'group-join-modal-overlay';
    modal.innerHTML = `
      <div class="group-join-modal-box">
        <div class="gjm-avatar">${avatarHTML}</div>
        <div class="gjm-name">${escapeHTML(group.name)}</div>
        <div class="gjm-count">${memberCount} ${countWord}</div>
        <div class="gjm-actions">
          <button class="gjm-btn-cancel" onclick="Chat.closeGroupInviteModal()">Отмена</button>
          <button class="gjm-btn-join" onclick="Chat.joinGroupByInvite('${group.id}')">Вступить в группу</button>
        </div>
      </div>
    `;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeGroupInviteModal();
    });
    document.body.appendChild(modal);
  }

  function closeGroupInviteModal() {
    const modal = document.getElementById('group-join-modal');
    if (modal) modal.remove();
  }

  async function joinGroupByInvite(groupId) {
    closeGroupInviteModal();
    if (!currentUser) return;

    // Проверяем, уже ли состоит
    const { data: existing } = await window.supabaseClient
      .from('group_members')
      .select('user_id')
      .eq('group_id', groupId)
      .eq('user_id', currentUser.id)
      .maybeSingle();

    if (existing) {
      showToast('Вы уже состоите в этой группе', 'info');
      // Открываем группу
      const grp = groups.find(g => g.id === groupId);
      if (grp) openGroupChat(grp);
      return;
    }

    try {
      const { error } = await window.supabaseClient
        .from('group_members')
        .insert({ group_id: groupId, user_id: currentUser.id, role: 'member' });
      if (error) throw error;
      showToast('Вы вступили в группу!', 'success');
      await loadGroups();
      const grp = groups.find(g => g.id === groupId);
      if (grp) openGroupChat(grp);
    } catch (e) {
      showToast('Ошибка вступления: ' + e.message, 'error');
    }
  }

  // ---- Очистка при выходе ----
  function cleanup() {
    _initGeneration++; // сигнализируем текущему init прекратить выполнение
    if (realtimeSubscription) {
      window.supabaseClient.removeChannel(realtimeSubscription);
      realtimeSubscription = null;
    }
    if (reactionsSubscription) {
      window.supabaseClient.removeChannel(reactionsSubscription);
      reactionsSubscription = null;
    }
    if (presenceSubscription) {
      try { window.supabaseClient.removeChannel(presenceSubscription); } catch {}
      presenceSubscription = null;
    }
    if (lastSeenInterval) { clearInterval(lastSeenInterval); lastSeenInterval = null; }
    if (voiceTimerInterval) { clearInterval(voiceTimerInterval); voiceTimerInterval = null; }
    // Сбрасываем поиск и пагинацию
    disconnectTopObserver();
    msgSearchActive = false;
    msgSearchQuery = '';
    if (msgSearchTimer) { clearTimeout(msgSearchTimer); msgSearchTimer = null; }
    paginationPartnerId = null;
    oldestMsgDate = null;
    isLoadingMore = false;
    hasMoreMessages = true;
    unsubscribeTyping();
    editingMessageId = null;
    cancelEdit();
    if (groupRealtimeSubscription) {
      try { window.supabaseClient.removeChannel(groupRealtimeSubscription); } catch {}
      groupRealtimeSubscription = null;
    }
    if (groupsRealtimeSub) {
      try { window.supabaseClient.removeChannel(groupsRealtimeSub); } catch {}
      groupsRealtimeSub = null;
    }
    if (profilesRealtimeSub) {
      try { window.supabaseClient.removeChannel(profilesRealtimeSub); } catch {}
      profilesRealtimeSub = null;
    }
    exitSelectionMode();
    reactionsCache = {};
    renderedMessageIds.clear();
    selectedChat = null;
    selectedGroup = null;
    groups = [];
    groupMembersCache = {};
    groupSelectedMembers = [];
    // Cleanup каналов
    if (window.Channels) window.Channels.cleanup();
    // Сбрасываем данные, специфичные для аккаунта
    blockedUsers = new Set();
    trustedUsers = new Set();
    theyAddedMe = new Set();
    removedContacts = new Set();
    contactOverrides = {};
    // Сбрасываем «Цифровую вежливость»
    sendWhenOnlineMode = false;
    pendingOnlineMessages = [];
    if (sendWhenOnlinePresenceSub) {
      try { window.supabaseClient.removeChannel(sendWhenOnlinePresenceSub); } catch {}
      sendWhenOnlinePresenceSub = null;
    }
    // Останавливаем проверку сессии
    if (sessionCheckInterval) { clearInterval(sessionCheckInterval); sessionCheckInterval = null; }
    if (sessionRealtimeSub) {
      try { window.supabaseClient.removeChannel(sessionRealtimeSub); } catch {}
      sessionRealtimeSub = null;
    }
    // Удаляем сессию из БД при выходе
    if (currentSessionId && currentUser) {
      try {
        window.supabaseClient
          .from('user_sessions')
          .delete()
          .eq('id', currentSessionId)
          .then(() => {});
      } catch {}
    }
    currentSessionId = null;
    localStorage.removeItem(SESSION_KEY);
    currentUser = null;
    currentProfile = null;
    allProfiles = [];
    _profilesMap.clear();
    conversationsList = [];
    // Очищаем интервалы которые могли утечь
    if (_tokenRefreshInterval) { clearInterval(_tokenRefreshInterval); _tokenRefreshInterval = null; }
    if (_reactionsPollInterval) { clearInterval(_reactionsPollInterval); _reactionsPollInterval = null; }
  }

  // ============================================================
  // ---- Управление сессиями ----
  // ============================================================

  // Текущий session_id хранится в localStorage
  // Каждый вход генерирует НОВЫЙ ID — это позволяет отличать разные входы
  const SESSION_KEY = 'iflash_session_id';
  let currentSessionId = null;
  let sessionCheckInterval = null;
  let sessionRealtimeSub = null;

  // Генерируем НОВЫЙ session_id при каждом входе
  function createNewSessionId() {
    const sid = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    localStorage.setItem(SESSION_KEY, sid);
    return sid;
  }

  // Читаем текущий session_id (без создания нового)
  function getCurrentSessionId() {
    return localStorage.getItem(SESSION_KEY);
  }

  // Регистрируем сессию при входе
  async function registerSession() {
    if (!currentUser) return;
    if (currentSessionId) return; // Уже зарегистрирована — не создаём дублей
    const ua = navigator.userAgent;
    const device = detectDevice(ua);

    // Пробуем восстановить существующую сессию из localStorage
    const existingId = getCurrentSessionId();
    if (existingId) {
      try {
        const { data: existRow } = await window.supabaseClient
          .from('user_sessions')
          .select('id')
          .eq('id', existingId)
          .eq('user_id', currentUser.id)
          .maybeSingle();
        if (existRow) {
          // Сессия жива — переиспользуем её
          currentSessionId = existingId;
          await window.supabaseClient.from('user_sessions')
            .update({ last_active: new Date().toISOString() })
            .eq('id', currentSessionId);
          _subscribeSessionRevoke();
          _startSessionInterval();
          return;
        }
      } catch { /* таблица не существует */ }
    }

    // Создаём новую сессию
    currentSessionId = createNewSessionId();
    try {
      await window.supabaseClient.from('user_sessions').insert({
        id: currentSessionId,
        user_id: currentUser.id,
        device,
        user_agent: ua.slice(0, 300),
        last_active: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
    } catch {
      // Таблица не создана — ничего страшного
      return;
    }

    _subscribeSessionRevoke();
    _startSessionInterval();
  }

  function _startSessionInterval() {
    if (sessionCheckInterval) clearInterval(sessionCheckInterval);
    sessionCheckInterval = setInterval(async () => {
      if (!currentSessionId || !currentUser) return;
      try {
        const { data } = await window.supabaseClient
          .from('user_sessions')
          .select('id')
          .eq('id', currentSessionId)
          .maybeSingle();
        if (!data) {
          _forceLogoutBySession();
        } else {
          await window.supabaseClient
            .from('user_sessions')
            .update({ last_active: new Date().toISOString() })
            .eq('id', currentSessionId);
        }
      } catch {}
    }, 30 * 1000);
  }

  // Подписка на Realtime: если наша сессия удалена — сразу выходим
  function _subscribeSessionRevoke() {
    if (!currentUser || !currentSessionId) return;
    if (sessionRealtimeSub) {
      try { window.supabaseClient.removeChannel(sessionRealtimeSub); } catch {}
      sessionRealtimeSub = null;
    }

    // Используем broadcast для мгновенного выхода (не требует REPLICA IDENTITY FULL)
    // + postgres_changes как резервный вариант
    sessionRealtimeSub = window.supabaseClient
      .channel(`session-revoke-${currentSessionId}`)
      .on('broadcast', { event: 'revoked' }, () => {
        _forceLogoutBySession();
      })
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'user_sessions',
          filter: `id=eq.${currentSessionId}`,
        },
        () => {
          _forceLogoutBySession();
        }
      )
      .subscribe();
  }

  // Принудительный выход при удалении сессии
  async function _forceLogoutBySession() {
    if (!currentUser) return; // уже вышли
    showToast('Сессия завершена с другого устройства. Войдите снова.', 'info');
    // Небольшая задержка чтобы toast был виден
    setTimeout(async () => {
      try {
        await window.supabaseClient.auth.signOut();
      } catch {}
      cleanup();
      window.App && window.App.onLogout();
    }, 1500);
  }

  function detectDevice(ua) {
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS X/i.test(ua)) return 'macOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Неизвестно';
  }

  // Загружаем список сессий
  async function loadSessionsList() {
    const container = getEl('sessions-list');
    if (!container || !currentUser) return;
    container.innerHTML = '<div class="sessions-loading">Загрузка...</div>';

    currentSessionId = getCurrentSessionId();

    try {
      const { data, error } = await window.supabaseClient
        .from('user_sessions')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('last_active', { ascending: false });

      if (error) {
        container.innerHTML = '<div class="sessions-error">Таблица сессий не найдена.<br>Запустите <code>sessions_migration.sql</code></div>';
        return;
      }

      const sessions = data || [];
      if (sessions.length === 0) {
        container.innerHTML = '<div class="sessions-empty">Нет активных сессий</div>';
        return;
      }

      container.innerHTML = sessions.map(s => {
        const isCurrent = s.id === currentSessionId;
        const lastActive = new Date(s.last_active).toLocaleString('ru-RU');
        const createdAt = new Date(s.created_at).toLocaleDateString('ru-RU');
        return `
          <div class="session-item${isCurrent ? ' session-item--current' : ''}">
            <div class="session-icon">${getDeviceIcon(s.device)}</div>
            <div class="session-info">
              <div class="session-device">${escapeHTML(s.device || 'Устройство')}${isCurrent ? ' <span class="session-current-badge">Это устройство</span>' : ''}</div>
              <div class="session-meta">Последняя активность: ${lastActive}</div>
              <div class="session-meta">Вход: ${createdAt}</div>
            </div>
            ${!isCurrent ? `<button class="session-revoke-btn" onclick="Chat.revokeSession('${s.id}')">Завершить</button>` : ''}
          </div>
        `;
      }).join('');
    } catch (e) {
      container.innerHTML = '<div class="sessions-error">Ошибка загрузки сессий</div>';
    }
  }

  function getDeviceIcon(device) {
    if (!device) return '💻';
    if (/Android|iOS/i.test(device)) return '📱';
    if (/Windows|macOS|Linux/i.test(device)) return '🖥️';
    return '💻';
  }

  async function revokeSession(sessionId) {
    try {
      // Сначала отправляем broadcast — мгновенный выход на том устройстве
      try {
        const broadcastCh = window.supabaseClient.channel(`session-revoke-${sessionId}`);
        await broadcastCh.subscribe();
        await broadcastCh.send({ type: 'broadcast', event: 'revoked', payload: {} });
        // Небольшая пауза, чтобы broadcast дошёл до адресата
        await new Promise(r => setTimeout(r, 300));
        window.supabaseClient.removeChannel(broadcastCh);
      } catch {}

      // Удаляем из БД
      await window.supabaseClient
        .from('user_sessions')
        .delete()
        .eq('id', sessionId)
        .eq('user_id', currentUser.id);
      showToast('Сессия завершена', 'success');
      loadSessionsList();
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function revokeAllOtherSessions() {
    currentSessionId = getCurrentSessionId();
    try {
      await window.supabaseClient
        .from('user_sessions')
        .delete()
        .eq('user_id', currentUser.id)
        .neq('id', currentSessionId);
      showToast('Все другие сессии завершены', 'success');
      loadSessionsList();
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  // ============================================================
  // ---- Синхронизация user_blocks с Supabase ----
  // ============================================================

  // Переопределяем blockUser чтобы писать в Supabase
  async function syncBlockToSupabase(blockedId, block) {
    if (!currentUser) return;
    try {
      if (block) {
        await window.supabaseClient
          .from('user_blocks')
          .upsert({ blocker_id: currentUser.id, blocked_id: blockedId }, { onConflict: 'blocker_id,blocked_id' });
      } else {
        await window.supabaseClient
          .from('user_blocks')
          .delete()
          .eq('blocker_id', currentUser.id)
          .eq('blocked_id', blockedId);
      }
    } catch {
      // Таблица user_blocks не создана — работаем с localStorage
    }
  }

  // ============================================================
  // ---- ВЫДЕЛЕНИЕ СООБЩЕНИЙ (мультиселект) ----
  // ============================================================

  let selectionMode = false;
  const selectedMsgIds = new Set();

  // Войти в режим выделения — первый выбранный msgId
  function enterSelectionMode(msgId) {
    if (selectionMode) {
      toggleMessageSelection(msgId);
      return;
    }
    selectionMode = true;
    selectedMsgIds.clear();
    const container = getEl('messages-container');
    if (container) container.classList.add('selection-active');
    _showSelectionToolbar();
    toggleMessageSelection(msgId);
  }

  // Выйти из режима выделения
  function exitSelectionMode() {
    if (!selectionMode) return;
    selectionMode = false;
    selectedMsgIds.clear();
    const container = getEl('messages-container');
    if (container) container.classList.remove('selection-active');
    document.querySelectorAll('.msg-selected').forEach(el => el.classList.remove('msg-selected'));
    const toolbar = getEl('msg-select-toolbar');
    if (toolbar) toolbar.remove();
  }

  // Переключить выделение отдельного сообщения
  function toggleMessageSelection(msgId) {
    if (selectedMsgIds.has(msgId)) {
      selectedMsgIds.delete(msgId);
    } else {
      selectedMsgIds.add(msgId);
    }
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (el) el.classList.toggle('msg-selected', selectedMsgIds.has(msgId));
    if (selectedMsgIds.size === 0) {
      exitSelectionMode();
    } else {
      _updateSelectionToolbar();
    }
  }

  // Показать тулбар выделения
  function _showSelectionToolbar() {
    let toolbar = getEl('msg-select-toolbar');
    if (toolbar) toolbar.remove();
    toolbar = document.createElement('div');
    toolbar.id = 'msg-select-toolbar';
    toolbar.className = 'msg-select-toolbar';
    // Вставляем перед полем ввода чтобы не перекрывало текст
    const inputArea = document.querySelector('.chat-input-area');
    if (inputArea) {
      inputArea.parentNode.insertBefore(toolbar, inputArea);
    } else {
      const chatArea = getEl('chat-area');
      if (chatArea) chatArea.appendChild(toolbar);
    }
    _updateSelectionToolbar();
  }

  // Обновить содержимое тулбара
  function _updateSelectionToolbar() {
    const toolbar = getEl('msg-select-toolbar');
    if (!toolbar) return;
    const count = selectedMsgIds.size;
    const label = count === 1 ? '1 сообщение' : count < 5 ? `${count} сообщения` : `${count} сообщений`;

    // Проверяем есть ли среди выбранных мои сообщения (для кнопки "удалить для всех")
    let hasMine = false;
    selectedMsgIds.forEach(id => {
      const el = document.querySelector(`[data-msg-id="${id}"]`);
      if (el && (el.classList.contains('own') || el.classList.contains('gm-own'))) hasMine = true;
    });

    toolbar.innerHTML = `
      <button class="msg-sel-btn msg-sel-cancel" onclick="Chat.exitSelectionMode()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <span class="msg-sel-count">${label}</span>
      <div class="msg-sel-actions">
        ${count > 0 ? `<button class="msg-sel-btn msg-sel-forward" onclick="Chat.forwardSelectedMessages()" title="Переслать">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>
          <span>Переслать</span>
        </button>` : ''}
        ${count > 0 ? `<button class="msg-sel-btn msg-sel-delete-me" onclick="Chat.deleteSelectedMessages('me')" title="Удалить у себя" style="font-size:12px;">
          🙈 У себя
        </button>` : ''}
        ${count > 0 && hasMine ? `<button class="msg-sel-btn msg-sel-delete msg-sel-delete-all" onclick="Chat.deleteSelectedMessages('all')" title="Удалить для всех" style="font-size:12px;">
          🗑️ Для всех
        </button>` : ''}
      </div>
    `;
  }

  // Удалить все выбранные сообщения
  // mode: 'me' = только у себя, 'all' = для всех (только свои)
  async function deleteSelectedMessages(mode = 'me') {
    if (selectedMsgIds.size === 0) return;
    const ids = [...selectedMsgIds];

    // Собираем данные до выхода из режима выбора (DOM ещё не сброшен)
    const msgMeta = ids.map(id => {
      const el = document.querySelector(`[data-msg-id="${id}"]`);
      const isMine = el && (el.classList.contains('own') || el.classList.contains('gm-own'));
      return { id, isMine };
    });

    exitSelectionMode();

    for (const { id, isMine } of msgMeta) {
      if (mode === 'all' && isMine) {
        // Удалить для всех — только свои сообщения
        if (selectedGroup) {
          await deleteGroupMessageForAll(id);
        } else {
          await deleteMessageForAll(id);
        }
      } else {
        // Удалить только у себя
        await deleteMessageForMe(id);
      }
    }
  }

  // Переслать выбранные сообщения (каждое по отдельности)
  function forwardSelectedMessages() {
    if (selectedMsgIds.size === 0) return;

    // Сортируем по порядку в DOM (сверху вниз)
    const allMsgEls = [...document.querySelectorAll('[data-msg-id]')];
    const idsOrdered = allMsgEls
      .map(el => el.dataset.msgId)
      .filter(id => selectedMsgIds.has(id));

    if (idsOrdered.length === 0) return;

    // Собираем очередь: для каждого сообщения — id, текст, отправитель
    forwardMsgQueue = idsOrdered.map(id => {
      const el = document.querySelector(`[data-msg-id="${id}"]`);
      const isOwn = el && (el.classList.contains('own') || el.classList.contains('gm-own'));

      // Текст сообщения
      const textEl = el && el.querySelector('.msg-text');
      const text = textEl ? textEl.textContent.trim() : '';

      // Отправитель
      let senderName, senderId;
      if (isOwn) {
        senderName = currentProfile ? getDisplayName(currentProfile) : 'Я';
        senderId = currentUser?.id || null;
      } else if (selectedChat) {
        senderName = getDisplayName(selectedChat);
        senderId = selectedChat.id;
      } else if (selectedGroup) {
        // Групповое — берём из data-sender-id или из имени внутри
        const sid = el && el.dataset.senderId;
        const senderProfile = sid ? allProfiles.find(p => p.id === sid) : null;
        senderName = senderProfile ? getContactDisplayName(senderProfile) : 'Участник';
        senderId = sid || null;
      } else {
        senderName = '?';
        senderId = null;
      }

      return { msgId: id, text, senderName, senderId };
    });

    exitSelectionMode();

    if (forwardMsgQueue.length === 1) {
      // Одно сообщение — старый путь
      const q = forwardMsgQueue[0];
      forwardMsgQueue = [];
      openForwardModal(q.msgId, q.text);
    } else {
      // Несколько — открываем модал; кнопка отправит каждое по отдельности
      openForwardModal(null, null);
    }
  }

  // ============================================================
  // Удаление группы
  // ============================================================

  function showDeleteGroupConfirm(groupId) {
    document.getElementById('delete-group-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'delete-group-modal';
    modal.style.cssText = [
      'position:fixed;inset:0;z-index:10010',
      'display:flex;align-items:center;justify-content:center',
      'background:rgba(0,0,0,0.6);backdrop-filter:blur(6px)',
    ].join(';');
    modal.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--glass-border);
                  border-radius:18px;padding:28px 24px;max-width:320px;width:90%;
                  text-align:center;display:flex;flex-direction:column;gap:12px;
                  box-shadow:0 24px 64px rgba(0,0,0,.5);animation:slideUp .2s ease;">
        <div style="font-size:36px;">🗑️</div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary);">Удалить группу?</div>
        <div style="font-size:13px;color:var(--text-muted);line-height:1.6;">
          Все сообщения, участники и медиафайлы группы будут удалены навсегда.<br>Это действие нельзя отменить.
        </div>
        <div style="display:flex;gap:10px;margin-top:6px;">
          <button onclick="document.getElementById('delete-group-modal').remove()"
            style="flex:1;padding:10px;background:var(--bg-glass);border:1px solid var(--border-color);
                   border-radius:10px;color:var(--text-primary);font-size:14px;cursor:pointer;">Отмена</button>
          <button onclick="Chat._confirmDeleteGroup('${groupId}')"
            style="flex:1;padding:10px;background:#ef4444;border:none;
                   border-radius:10px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">Удалить</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  async function _confirmDeleteGroup(groupId) {
    document.getElementById('delete-group-modal')?.remove();
    closeGroupInfo();

    // Оптимистично: убираем группу из UI немедленно
    groups = groups.filter(g => g.id !== groupId);
    if (selectedGroup && selectedGroup.id === groupId) {
      selectedGroup = null;
      const welcome = getEl('welcome-screen');
      const chatArea = getEl('chat-area');
      if (welcome) welcome.style.display = '';
      if (chatArea) chatArea.style.display = 'none';
    }
    renderGroupsInList(getEl('conversations-list'));
    showToast('Группа удалена', 'success');

    // Удаляем в фоне — пользователь не ждёт
    _deleteGroupInBackground(groupId);
  }

  async function _deleteGroupInBackground(groupId) {
    try {
      // 1. Получаем данные группы (для удаления аватарки)
      const { data: grp } = await window.supabaseClient
        .from('groups').select('avatar_url').eq('id', groupId).maybeSingle();

      // 2. Удаляем сообщения группы
      await window.supabaseClient.from('group_messages').delete().eq('group_id', groupId);

      // 3. Удаляем участников
      await window.supabaseClient.from('group_members').delete().eq('group_id', groupId);

      // 4. Удаляем закреплённое сообщение если есть
      await window.supabaseClient.from('pinned_messages').delete().eq('id', 'grp_' + groupId);

      // 5. Удаляем аватарку из Storage
      if (grp?.avatar_url) {
        try {
          const url = new URL(grp.avatar_url);
          const parts = url.pathname.split('/group-avatars/');
          if (parts[1]) {
            await window.supabaseClient.storage.from('group-avatars').remove([decodeURIComponent(parts[1])]);
          }
        } catch {}
      }

      // 6. Удаляем саму группу
      await window.supabaseClient.from('groups').delete().eq('id', groupId);
    } catch (e) {
      console.error('[deleteGroup] Ошибка фонового удаления:', e);
    }
  }

  async function leaveGroupFromPanel(groupId) {
    closeGroupInfo();
    await leaveGroup(groupId);
  }

  // ============================================================
  // WebRTC — Голосовые звонки
  // ============================================================

  function modifySDPForOpus(sdp) {
    const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/);
    if (!opusMatch) return sdp;
    const pt = opusMatch[1];
    const fmtpRe = new RegExp(`(a=fmtp:${pt} )([^\r\n]*)`);
    const newFmtp = `maxaveragebitrate=16000;usedtx=1;stereo=0;useinbandfec=1`;
    if (fmtpRe.test(sdp)) {
      return sdp.replace(fmtpRe, `$1${newFmtp}`);
    }
    return sdp.replace(
      new RegExp(`(a=rtpmap:${pt} opus\\/48000\\/2)`),
      `$1\r\na=fmtp:${pt} ${newFmtp}`
    );
  }

  function _cleanupCall() {
    _stopCallBeeps();
    _stopRingSound();
    _stopIcePoll();
    _pendingIceCandidates = [];
    if (_callMicAnimFrame) { cancelAnimationFrame(_callMicAnimFrame); _callMicAnimFrame = null; }
    if (_callMicAnalyser) { try { _callMicAnalyser.context.close(); } catch {} _callMicAnalyser = null; }
    _callMuted = false;
    if (activePeerConnection) {
      activePeerConnection.ontrack = null;
      activePeerConnection.onicecandidate = null;
      activePeerConnection.onconnectionstatechange = null;
      try { activePeerConnection.close(); } catch {}
      activePeerConnection = null;
    }
    if (activeLocalStream) {
      activeLocalStream.getTracks().forEach(t => t.stop());
      activeLocalStream = null;
    }
    const remAudio = document.getElementById('call-remote-audio');
    if (remAudio) remAudio.remove();
    if (callSignalSub) {
      try { window.supabaseClient.removeChannel(callSignalSub); } catch {}
      callSignalSub = null;
    }
    if (callRingInterval) { clearTimeout(callRingInterval); callRingInterval = null; }
    if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
    callDurationSec = 0;
    activeCallId = null;
    activeCallUserId = null;
    isCallInitiator = false;
    _hideCallModal();
  }

  function _hideCallModal() {
    const m = document.getElementById('call-modal');
    if (m) { m.classList.remove('visible'); setTimeout(() => m.remove(), 300); }
  }

  function _callFmtTime(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  // ---- Настройки микрофона в звонке ----
  let _callCurrentMicId = null; // текущий deviceId микрофона

  const _callSettingsGearSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

  async function _toggleCallMicPicker() {
    const existing = document.getElementById('call-mic-picker');
    if (existing) { existing.remove(); return; }

    let devices = [];
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      devices = list.filter(d => d.kind === 'audioinput');
    } catch { return; }

    if (devices.length === 0) { showToast('Микрофоны не найдены', 'warning'); return; }

    // Определяем текущий deviceId
    let currentId = _callCurrentMicId || '';
    if (!currentId && activeLocalStream) {
      const track = activeLocalStream.getAudioTracks()[0];
      if (track) currentId = track.getSettings().deviceId || '';
    }

    const picker = document.createElement('div');
    picker.id = 'call-mic-picker';
    picker.className = 'call-mic-picker';
    picker.innerHTML = `<div class="call-mic-picker-title">🎤 Микрофон</div>` +
      devices.map((d, i) => {
        const label = d.label || `Микрофон ${i + 1}`;
        const isActive = d.deviceId === currentId;
        return `<button class="call-mic-picker-item${isActive ? ' active' : ''}" data-device-id="${d.deviceId}">
          <span class="mic-check">${isActive ? '✓' : ''}</span>
          <span>${escapeHTML(label)}</span>
        </button>`;
      }).join('');

    picker.addEventListener('click', async (e) => {
      const item = e.target.closest('.call-mic-picker-item');
      if (!item) return;
      const deviceId = item.dataset.deviceId;
      await _switchCallMic(deviceId);
      picker.remove();
    });

    const box = document.querySelector('.call-modal-box');
    if (box) box.appendChild(picker);

    // Закрытие по клику вне
    setTimeout(() => {
      function closePicker(ev) {
        if (!picker.contains(ev.target) && !ev.target.closest('.call-settings-btn')) {
          picker.remove();
          document.removeEventListener('click', closePicker, true);
        }
      }
      document.addEventListener('click', closePicker, true);
    }, 50);
  }

  async function _switchCallMic(deviceId) {
    if (!activeLocalStream || !activePeerConnection) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, sampleRate: 24000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) return;

      // Заменяем трек в PeerConnection
      const sender = activePeerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) await sender.replaceTrack(newTrack);

      // Останавливаем старый трек
      activeLocalStream.getAudioTracks().forEach(t => t.stop());
      activeLocalStream.removeTrack(activeLocalStream.getAudioTracks()[0]);
      activeLocalStream.addTrack(newTrack);

      _callCurrentMicId = deviceId;

      // Обновляем mute-состояние
      if (_callMuted) newTrack.enabled = false;

      // Перезапускаем индикатор
      if (_callMicAnimFrame) { cancelAnimationFrame(_callMicAnimFrame); _callMicAnimFrame = null; }
      if (_callMicAnalyser) { try { _callMicAnalyser.context.close(); } catch {} _callMicAnalyser = null; }
      _startCallMicIndicator();

      showToast('Микрофон переключён', 'success');
    } catch (err) {
      showToast('Не удалось переключить микрофон', 'error');
    }
  }

  // Иконки SVG для кнопок звонка
  const _callSVG = {
    phone: `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>`,
    hangup: `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>`,
    mic: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`,
    micoff: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`,
    gear: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  };

  function _showCallModal(state, profile) {
    document.getElementById('call-modal')?.remove();
    const name = profile ? escapeHTML(getContactDisplayName(profile)) : '…';

    // Аватар — либо картинка либо буква
    let avatarBg = 'linear-gradient(135deg,#6c5ce7,#a29bfe)';
    let avatarContent = '';
    if (profile && profile.avatar_url) {
      avatarContent = `<img src="${escapeHTML(profile.avatar_url)}" class="call-av-img" alt="">`;
    } else {
      const initials = (name || '?').charAt(0).toUpperCase();
      avatarContent = `<span class="call-av-letter">${initials}</span>`;
    }

    const avatarHTML = `
      <div class="call-av-wrap ${state === 'incoming' ? 'call-av-ring' : ''}">
        <div class="call-av-ring1"></div>
        <div class="call-av-ring2"></div>
        <div class="call-av-circle">${avatarContent}</div>
      </div>`;

    const phoneIconSVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.58.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.18 21 3 13.82 3 5c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.24 1.02L6.6 10.8z"/></svg>`;

    let statusText = '';
    let actionsHTML = '';
    let topBarHTML = '';

    if (state === 'outgoing') {
      statusText = 'Аудиозвонок';
      topBarHTML = `<button class="call-gear-btn" onclick="Chat._toggleCallMicPicker()" title="Настройки">${_callSVG.gear}</button>`;
      actionsHTML = `
        <div class="call-action-col">
          <button class="call-circle-btn call-circle-mute" id="call-mute-btn" onclick="Chat.toggleCallMute()">
            ${_callSVG.mic}
          </button>
          <span class="call-btn-label">Микрофон</span>
        </div>
        <div class="call-action-col">
          <button class="call-circle-btn call-circle-end" onclick="Chat.hangUp()">
            ${phoneIconSVG}
          </button>
          <span class="call-btn-label">Завершить</span>
        </div>`;
    } else if (state === 'incoming') {
      statusText = 'Входящий аудиозвонок';
      actionsHTML = `
        <div class="call-action-col">
          <button class="call-circle-btn call-circle-end" onclick="Chat.rejectCall()">
            ${phoneIconSVG}
          </button>
          <span class="call-btn-label">Отклонить</span>
        </div>
        <div class="call-action-col">
          <button class="call-circle-btn call-circle-accept" onclick="Chat.acceptCall()">
            ${phoneIconSVG}
          </button>
          <span class="call-btn-label">Принять</span>
        </div>`;
    } else if (state === 'active') {
      statusText = '00:00';
      topBarHTML = `<button class="call-gear-btn" onclick="Chat._toggleCallMicPicker()" title="Настройки">${_callSVG.gear}</button>`;
      actionsHTML = `
        <div class="call-action-col">
          <button class="call-circle-btn call-circle-mute" id="call-mute-btn" onclick="Chat.toggleCallMute()">
            ${_callSVG.mic}
          </button>
          <span class="call-btn-label">Звук</span>
        </div>
        <div class="call-action-col">
          <button class="call-circle-btn call-circle-end" onclick="Chat.hangUp()">
            ${phoneIconSVG}
          </button>
          <span class="call-btn-label">Завершить</span>
        </div>`;
    }

    const modal = document.createElement('div');
    modal.id = 'call-modal';
    modal.className = 'call-modal';
    modal.innerHTML = `
      <div class="call-modal-box">
        <div class="call-topbar">${topBarHTML}</div>
        ${avatarHTML}
        <div class="call-modal-name">${name}</div>
        <div class="call-modal-status ${state === 'active' ? 'call-timer' : ''}" id="call-modal-status">${escapeHTML(statusText)}</div>
        <div class="call-mic-indicator" id="call-mic-indicator" style="display:${state === 'active' ? 'flex' : 'none'}"><span class="call-mic-bar" id="call-mic-bar"></span></div>
        <div class="call-modal-actions">${actionsHTML}</div>
      </div>`;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('visible'));

    if (state === 'active') {
      if (callTimerInterval) clearInterval(callTimerInterval);
      callDurationSec = 0;
      callTimerInterval = setInterval(() => {
        callDurationSec++;
        const el = document.getElementById('call-modal-status');
        if (el) el.textContent = _callFmtTime(callDurationSec);
      }, 1000);
      _startCallMicIndicator();
    }
  }

  function _switchCallModalToActive() {
    _stopCallBeeps();
    _stopRingSound();
    const statusEl = document.getElementById('call-modal-status');
    const actionsEl = document.querySelector('.call-modal-actions');
    const micInd = document.getElementById('call-mic-indicator');
    const topBar = document.querySelector('.call-topbar');
    if (statusEl) { statusEl.textContent = '00:00'; statusEl.classList.add('call-timer'); }
    if (micInd) micInd.style.display = 'flex';
    // Показываем шестерёнку если её нет
    if (topBar && !topBar.querySelector('.call-gear-btn')) {
      topBar.innerHTML = `<button class="call-gear-btn" onclick="Chat._toggleCallMicPicker()">${_callSVG.gear}</button>`;
    }
    const phoneIconSVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.58.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.18 21 3 13.82 3 5c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.24 1.02L6.6 10.8z"/></svg>`;
    if (actionsEl) {
      actionsEl.innerHTML = `
        <div class="call-action-col">
          <button class="call-circle-btn call-circle-mute" id="call-mute-btn" onclick="Chat.toggleCallMute()">
            ${_callSVG.mic}
          </button>
          <span class="call-btn-label">Звук</span>
        </div>
        <div class="call-action-col">
          <button class="call-circle-btn call-circle-end" onclick="Chat.hangUp()">
            ${phoneIconSVG}
          </button>
          <span class="call-btn-label">Завершить</span>
        </div>`;
    }
    // Убираем анимацию пульса на аватаре
    document.querySelector('.call-av-wrap')?.classList.remove('call-av-ring');
    if (callTimerInterval) clearInterval(callTimerInterval);
    callDurationSec = 0;
    callTimerInterval = setInterval(() => {
      callDurationSec++;
      const el = document.getElementById('call-modal-status');
      if (el) el.textContent = _callFmtTime(callDurationSec);
    }, 1000);
    _startCallMicIndicator();
  }

  function _startCallMicIndicator() {
    if (!activeLocalStream) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(activeLocalStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      _callMicAnalyser = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      function tick() {
        _callMicAnimFrame = requestAnimationFrame(tick);
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length;
        const bar = document.getElementById('call-mic-bar');
        if (bar) bar.style.width = Math.min(100, avg * 3) + '%';
      }
      tick();
      // Watch for mic track ending (disconnected hardware)
      activeLocalStream.getAudioTracks().forEach(t => {
        t.onended = () => {
          showToast('Микрофон отключён', 'warning');
          const btn = document.getElementById('call-mute-btn');
          if (btn) btn.classList.add('call-btn--muted');
        };
      });
    } catch {}
  }

  function toggleCallMute() {
    if (!activeLocalStream) return;
    _callMuted = !_callMuted;
    activeLocalStream.getAudioTracks().forEach(t => { t.enabled = !_callMuted; });
    const btn = document.getElementById('call-mute-btn');
    if (btn) {
      btn.classList.toggle('call-btn--muted', _callMuted);
      btn.title = _callMuted ? 'Включить микрофон' : 'Отключить микрофон';
      btn.innerHTML = _callMuted ? _callSVG.micoff : _callSVG.mic;
      // Обновляем лейбл
      const col = btn.closest('.call-action-col');
      const lbl = col && col.querySelector('.call-btn-label');
      if (lbl) lbl.textContent = _callMuted ? 'Вкл. звук' : 'Звук';
    }
  }

  // Очередь ICE-кандидатов до получения activeCallId
  let _pendingIceCandidates = [];
  // Таймер polling ICE-кандидатов (фолбэк если realtime пропустил)
  let _icePollInterval = null;
  let _icePollLastTs = null;

  function _setupPeerConnection(stream) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    activePeerConnection = pc;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    pc.ontrack = (e) => {
      let audio = document.getElementById('call-remote-audio');
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'call-remote-audio';
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = e.streams[0];
    };

    // ICE-кандидаты: если activeCallId ещё не установлен — ставим в очередь
    pc.onicecandidate = async (e) => {
      if (!e.candidate) return;
      if (activeCallId) {
        await window.supabaseClient.from('call_candidates').insert({
          call_id: activeCallId,
          sender_id: currentUser.id,
          candidate: e.candidate.toJSON(),
        }).then(() => {}).catch(() => {});
      } else {
        _pendingIceCandidates.push(e.candidate.toJSON());
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] connectionState:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        _stopIcePoll();
        _switchCallModalToActive();
      } else if (pc.connectionState === 'failed') {
        // failed — обрываем звонок
        _stopIcePoll();
        if (activeCallId) {
          window.supabaseClient.from('calls')
            .update({ status: 'ended', ended_at: new Date().toISOString() })
            .eq('id', activeCallId).then(() => {}).catch(() => {});
        }
        _cleanupCall();
        showToast('Соединение не установлено', 'error');
      }
      // 'disconnected' и 'closed' — НЕ завершаем автоматически (может восстановиться)
    };

    return pc;
  }

  // Сбрасываем очередь кандидатов и отправляем накопленные в DB
  async function _flushPendingCandidates() {
    if (!_pendingIceCandidates.length || !activeCallId) return;
    const rows = _pendingIceCandidates.map(c => ({
      call_id: activeCallId,
      sender_id: currentUser.id,
      candidate: c,
    }));
    _pendingIceCandidates = [];
    await window.supabaseClient.from('call_candidates').insert(rows).catch(() => {});
  }

  // Polling ICE-кандидатов от собеседника (фолбэк для ненадёжного Realtime)
  function _startIcePoll(callId) {
    _stopIcePoll();
    _icePollLastTs = new Date().toISOString();
    _icePollInterval = setInterval(async () => {
      if (!activePeerConnection || !activeCallId) { _stopIcePoll(); return; }
      try {
        const since = _icePollLastTs;
        _icePollLastTs = new Date().toISOString();
        const { data } = await window.supabaseClient
          .from('call_candidates')
          .select('*')
          .eq('call_id', callId)
          .neq('sender_id', currentUser.id)
          .gte('created_at', since);
        if (data && data.length > 0) {
          for (const row of data) {
            try {
              await activePeerConnection.addIceCandidate(new RTCIceCandidate(row.candidate));
            } catch {}
          }
        }
      } catch {}
    }, 1500);
  }

  function _stopIcePoll() {
    if (_icePollInterval) { clearInterval(_icePollInterval); _icePollInterval = null; }
  }

  function _subscribeToCallSignaling(callId) {
    if (callSignalSub) {
      try { window.supabaseClient.removeChannel(callSignalSub); } catch {}
    }

    callSignalSub = window.supabaseClient
      .channel(`call-signal-${callId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'calls',
        filter: `id=eq.${callId}`,
      }, async (payload) => {
        const row = payload.new;
        if (!row) return;

        if (row.status === 'rejected' || row.status === 'ended' || row.status === 'missed') {
          const msg = row.status === 'rejected' ? 'Звонок отклонён' : 'Звонок завершён';
          _cleanupCall();
          showToast(msg, 'info');
          return;
        }

        // Caller receives answer
        if (isCallInitiator && row.status === 'active' && row.sdp_answer && activePeerConnection) {
          try {
            await activePeerConnection.setRemoteDescription({ type: 'answer', sdp: row.sdp_answer });
          } catch (e) { console.warn('[WebRTC] setRemoteDescription(answer) failed', e); }
          return;
        }
      })
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'call_candidates',
        filter: `call_id=eq.${callId}`,
      }, async (payload) => {
        const row = payload.new;
        if (!row || row.sender_id === currentUser.id) return;
        if (!activePeerConnection) return;
        try {
          await activePeerConnection.addIceCandidate(new RTCIceCandidate(row.candidate));
        } catch (e) { console.warn('[WebRTC] addIceCandidate failed', e); }
      })
      .subscribe();
  }

  async function initiateCall(userId) {
    if (activePeerConnection) { showToast('Уже идёт звонок', 'warning'); return; }

    const privacyError = await checkPrivacyForCall(userId);
    if (privacyError) { showPrivacyBlockModal(privacyError); return; }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 24000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch {
      showToast('Нет доступа к микрофону', 'error');
      return;
    }
    activeLocalStream = stream;
    activeCallUserId = userId;
    isCallInitiator = true;

    const callee = allProfiles.find(p => p.id === userId) || null;
    _showCallModal('outgoing', callee);
    // Гудки вызова (встроенный звук, пока ждём ответа)
    _startCallBeeps();

    const pc = _setupPeerConnection(stream);

    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    offer.sdp = modifySDPForOpus(offer.sdp);
    await pc.setLocalDescription(offer);

    const { data: callRow, error } = await window.supabaseClient.from('calls').insert({
      caller_id: currentUser.id,
      callee_id: userId,
      status: 'ringing',
      sdp_offer: offer.sdp,
    }).select().single();

    if (error || !callRow) {
      showToast('Ошибка при создании звонка: ' + (error?.message || 'нет ответа от БД'), 'error');
      _pendingIceCandidates = [];
      _cleanupCall();
      return;
    }
    activeCallId = callRow.id;

    // Отправляем кандидаты, которые накопились до получения callId
    await _flushPendingCandidates();

    _subscribeToCallSignaling(callRow.id);
    // Polling как резервный механизм
    _startIcePoll(callRow.id);

    // Auto-miss after 60 seconds
    callRingInterval = setTimeout(async () => {
      if (activeCallId === callRow.id) {
        await window.supabaseClient.from('calls').update({ status: 'missed', ended_at: new Date().toISOString() }).eq('id', callRow.id);
        _cleanupCall();
        showToast('Нет ответа', 'info');
      }
    }, 60000);
  }

  async function acceptCall() {
    if (!activeCallId || isCallInitiator) return;

    // Load the call row to get the SDP offer
    const { data: callRow } = await window.supabaseClient
      .from('calls').select('*').eq('id', activeCallId).maybeSingle();
    if (!callRow || !callRow.sdp_offer) {
      _cleanupCall();
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 24000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch {
      showToast('Нет доступа к микрофону', 'error');
      await window.supabaseClient.from('calls').update({ status: 'rejected', ended_at: new Date().toISOString() }).eq('id', activeCallId);
      _cleanupCall();
      return;
    }
    activeLocalStream = stream;

    const pc = _setupPeerConnection(stream);
    await pc.setRemoteDescription({ type: 'offer', sdp: callRow.sdp_offer });

    const answer = await pc.createAnswer();
    answer.sdp = modifySDPForOpus(answer.sdp);
    await pc.setLocalDescription(answer);

    await window.supabaseClient.from('calls').update({
      status: 'active',
      sdp_answer: answer.sdp,
    }).eq('id', activeCallId);

    // Отправляем кандидаты, накопившиеся во время создания answer
    await _flushPendingCandidates();
    // Polling кандидатов от звонящего
    _startIcePoll(activeCallId);

    const caller = allProfiles.find(p => p.id === callRow.caller_id) || null;
    _showCallModal('active', caller);
  }

  async function rejectCall() {
    if (!activeCallId) { _cleanupCall(); return; }
    await window.supabaseClient.from('calls').update({ status: 'rejected', ended_at: new Date().toISOString() }).eq('id', activeCallId);
    _cleanupCall();
  }

  async function hangUp() {
    if (activeCallId) {
      await window.supabaseClient.from('calls').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', activeCallId);
    }
    _cleanupCall();
  }

  // Глобальная подписка на входящие звонки (запускается при init)
  function subscribeToIncomingCalls() {
    window.supabaseClient
      .channel('incoming-calls')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'calls',
        filter: `callee_id=eq.${currentUser.id}`,
      }, async (payload) => {
        const row = payload.new;
        if (!row || row.status !== 'ringing') return;
        // Блокировка: отклоняем звонки от заблокированных пользователей
        if (blockedUsers.has(row.caller_id)) {
          await window.supabaseClient.from('calls').update({ status: 'rejected', ended_at: new Date().toISOString() }).eq('id', row.id);
          return;
        }
        if (activePeerConnection) {
          // Already in a call — reject automatically
          await window.supabaseClient.from('calls').update({ status: 'rejected', ended_at: new Date().toISOString() }).eq('id', row.id);
          return;
        }
        activeCallId = row.id;
        activeCallUserId = row.caller_id;
        isCallInitiator = false;

        // Загружаем профиль звонящего если его нет в кэше
        let caller = allProfiles.find(p => p.id === row.caller_id) || null;
        if (!caller) {
          try {
            const { data: cp } = await window.supabaseClient.from('profiles').select('*').eq('id', row.caller_id).single();
            if (cp) { caller = cp; _cacheProfile(cp); }
          } catch {}
        }

        _showCallModal('incoming', caller);
        _startRingSound();

        // Подписка на сигналы (realtime)
        _subscribeToCallSignaling(row.id);
        // Polling как резервный
        _startIcePoll(row.id);

        // Notification (call — always show regardless of focus)
        const callerName = caller ? getContactDisplayName(caller) : 'Неизвестный';
        _showCallNotification(callerName, row.caller_id);
      })
      .subscribe();
  }

  // ---- Публичный API ----
  return {
    init,
    cleanup,
    selectConversation,
    openChatWithUser,
    showUserProfile,
    closeProfileModal,
    switchProfileMediaTab,
    switchGroupMediaTab,
    toggleSendWhenOnline,
    updateSendOnlineBtn: _updateSendOnlineBtn,
    openImageModal,
    closeImageModal,
    toggleSettings,
    closeSettings,
    closeMenu,
    openMenuPage,
    closeMenuPage,
    openSettingsSection,
    closeSettingsSection,
    setWallpaper,
    clearSelectedFile,
    addReaction,
    toggleReactionPicker,
    toggleReactionPickerExpand,
    goBackToList,
    showToast,
    unblockUser,
    toggleBlockFromHeader,
    toggleBlockFromProfile,
    cancelVoiceRecording,
    cancelUpload,
    stopVoiceRecording,
    startVoiceRecording,
    sendVoiceMessage,
    toggleVoicePreviewPlay,
    toggleMsgVoice,
    seekMsgVoice,
    onVoiceMetaLoaded,
    onVoiceTimeUpdate,
    onVoiceEnded,
    onVidnoteMetaLoaded,
    toggleVoiceModePicker,
    hideVoiceModeBar,
    toggleEmojiPicker,
    searchEmoji,
    startVideoNoteRecording,
    stopVideoNoteRecording,
    cancelVideoNoteRecording,
    sendVideoNote,
    toggleVidnote,
    _toggleMsgCollapse,
    _formatFileSize: formatFileSize,
    copyInviteCode,
    refreshInvitesList: loadInvitesList,
    deleteAccount,
    _inviteCtxMenu,
    // Настройки — аккордеон (заглушка)
    toggleSettingsGroup,
    // Контакты
    addContact,
    addContactFromProfile,
    removeContact,
    openContactEditModal,
    _cemAvatarChange,
    _cemSave,
    _cemReset,
    // Группы
    openCreateGroupModal,
    closeCreateGroupModal,
    confirmCreateGroup,
    addGroupMember,
    removeGroupMember,
    // Закреплённые сообщения
    unpinMessage,
    scrollToPinnedMessage,
    // Удаление и редактирование
    deleteMessageForMe,
    deleteMessageForAll,
    startEditMessage,
    cancelEdit,
    // Typing
    sendTypingEvent,
    // Пересылка
    openForwardModal,
    closeForwardModal,
    // Контекстное меню диалога (ПКМ)
    showConvContextMenu,
    convCtxMarkUnread,
    convCtxDeleteChat,
    convCtxBlockWithOptions,
    closeModalAnimated,
    // Поиск по пользователям (в списке диалогов)
    clearSearch,
    // Поиск по сообщениям
    toggleMsgSearch,
    // Сессии
    revokeSession,
    revokeAllOtherSessions,
    // Группа — инфо панель
    openGroupInfo,
    closeGroupInfo,
    groupMemberActions,
    groupKickMember,
    groupMuteUser,
    groupUnmuteUser,
    groupPromoteAdmin,
    groupRenameModal,
    groupChangeAvatarStart,
    // Пригласительные ссылки групп
    generateGroupInviteLink,
    joinGroupByInvite,
    closeGroupInviteModal,
    _handleGroupInviteClick: handleGroupInviteClick,
    // Кроппер аватарки
    applyCrop,
    openAvatarCropper,
    closeAvatarCropper,
    // Выделение сообщений
    enterSelectionMode,
    exitSelectionMode,
    toggleMessageSelection,
    deleteSelectedMessages,
    forwardSelectedMessages,
    // Экспорт состояния для channels.js
    get _currentUser() { return currentUser; },
    get _allProfiles() { return allProfiles; },
    get _conversationsList() { return conversationsList; },
    _clearSelection() {
      // Сбрасываем выбранный чат/группу при переключении на канал
      selectedChat = null;
      selectedGroup = null;
    },
    _channelsHook: true,
    // Безопасность / Приватность
    toggleProtectedMode,
    setPrivacySetting,
    checkPrivacyForMessage,
    checkPrivacyForCall,
    showPrivacyBlockModal,
    // Тема
    setTheme,
    // Перезагрузить список диалогов (вызывается извне, напр. channels.js после join)
    reloadConversations: loadConversations,
    _getSelectedFile: () => selectedFile,
    _getSelectedFiles: () => selectedFiles,
    _removeSelectedFile,
    // Звонки
    initiateCall,
    acceptCall,
    rejectCall,
    hangUp,
    toggleCallMute,
    _toggleCallMicPicker,
    // Удаление группы
    showDeleteGroupConfirm,
    _confirmDeleteGroup,
    leaveGroupFromPanel,
    // Открыть группу по ID (для комментариев канала)
    _openGroupById: async function(groupId) {
      await loadGroups();
      const grp = (window.Chat._groups || []).find(g => g.id === groupId);
      if (grp) { openGroupChat(grp); } else { toast('Группа не найдена. Вы можете не состоять в ней.', 'error'); }
    },
    get _groups() { return typeof groups !== 'undefined' ? groups : []; },
    // Определение устройства (для доступа из других модулей)
    get isMobile() { return _isMobile; },
    get isTablet() { return _isTablet; },
    get isDesktop() { return _isDesktop; },
    get isTouchDevice() { return _isTouchDevice; },
    // Ответ на сообщение
    cancelReply,
    scrollToMessage,
    // Форматирование текста (используется также в channels.js)
    _linkifyText: linkifyText,
    _applyTextFormatting,
    _renderLongText,
    // E2EE
    confirmResetE2EE,
    reloadE2eeKey,
    // Статус онлайн/оффлайн
    _setOffline,
    // Кастомные обои
    pickCustomWallpaper,
    applyCustomWallpaper,
    clearCustomWallpaper,
    // Звуки
    applyCustomNotifSound,
    previewNotifSound,
    resetNotifSound,
    applyCustomRingSound,
    previewRingSound,
    resetRingSound,
  };

  // ---- Перетаскивание границы сайдбара ----
  function initSidebarResizer() {
    const handle = document.getElementById('sidebar-resizer');
    const sidebar = document.querySelector('.sidebar');
    if (!handle || !sidebar) return;

    const SIDEBAR_MIN = 180;
    const SIDEBAR_MAX = 720;
    const STORAGE_KEY = 'iflash_sidebar_width';

    // Восстанавливаем сохранённую ширину
    const savedW = parseInt(localStorage.getItem(STORAGE_KEY));
    if (savedW && savedW >= SIDEBAR_MIN && savedW <= SIDEBAR_MAX) {
      sidebar.style.width = savedW + 'px';
    }

    let isResizing = false;
    let startX = 0;
    let startW = 0;

    handle.addEventListener('mousedown', (e) => {
      if (window.innerWidth <= 768) return;
      isResizing = true;
      startX = e.clientX;
      startW = sidebar.offsetWidth;
      handle.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const delta = e.clientX - startX;
      const newW = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + delta));
      sidebar.style.width = newW + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      handle.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(STORAGE_KEY, sidebar.offsetWidth);
    });

    // Touch support
    handle.addEventListener('touchstart', (e) => {
      if (window.innerWidth <= 768) return;
      isResizing = true;
      startX = e.touches[0].clientX;
      startW = sidebar.offsetWidth;
      handle.classList.add('resizing');
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!isResizing) return;
      const delta = e.touches[0].clientX - startX;
      const newW = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + delta));
      sidebar.style.width = newW + 'px';
    }, { passive: true });

    document.addEventListener('touchend', () => {
      if (!isResizing) return;
      isResizing = false;
      handle.classList.remove('resizing');
      localStorage.setItem(STORAGE_KEY, sidebar.offsetWidth);
    });
  }
})();

window.Chat = Chat;
