// ============================================================
// channels.js — Логика каналов IFlash
// Подключается после chat.js в index.html
// ============================================================

(function () {
  // Ждём готовности Chat
  function whenReady(fn) {
    if (window.Chat && window.Chat._channelsHook) { fn(); return; }
    document.addEventListener('DOMContentLoaded', fn);
  }

  // Состояние каналов
  let channels = [];
  let selectedChannel = null;
  let _channelLoadGen = 0; // Защита от race condition при быстром переключении каналов
  let channelRealtimeSub = null;
  let channelUpdatesSub = null;
  let channelMembersCache = {}; // { channelId: { members, count } }
  let pendingInviteChannelId = null; // ID канала для вступления через invite
  let pendingInviteChannel = null;   // Объект канала
  let searchChannelResults = [];     // Результаты поиска публичных каналов
  let _channelCreateType = 'public'; // 'public' | 'private'
  let userSubsCache = {};            // { userId: 'none'|'plus'|'pro' }
  let channelPolls = [];             // Опросы текущего канала
  let chReactionsCache = {};         // { msgId: { emoji: Set<userId> } }
  let channelUnreadMap = {};         // { channelId: count } — непрочитанные сообщения каналов
  let _channelReplyTo = null;       // { msgId, text, quoteText }
  // Утилиты
  const sb = () => window.supabaseClient;
  const getEl = id => document.getElementById(id);
  const escHTML = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // ── Форматирование текста канала (ссылки + маркдаун) ─────────────────────
  // Использует функции из chat.js через публичный API (доступен т.к. channels.js подключается после)
  function _chFormatText(rawText) {
    if (!rawText) return '';
    const C = window.Chat;
    if (C && C._linkifyText && C._applyTextFormatting) {
      return C._applyTextFormatting(C._linkifyText(rawText));
    }
    // Fallback — просто экранируем
    return escHTML(rawText);
  }

  // Сворачиваемый длинный текст для канала (с форматированием)
  const CH_COLLAPSE_LIMIT = 600;
  const CH_COLLAPSE_PREVIEW = 500;
  function toast(msg, type = 'info') {
    if (window.Chat && window.Chat.showToast) window.Chat.showToast(msg, type);
  }
  function fmtDate(str) {
    if (!str) return '';
    const d = new Date(str);
    const now = new Date();
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    if (diffDays < 7) return d.toLocaleDateString('ru', { weekday: 'short' });
    return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
  }
  function pluralMembers(n) {
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return n + ' подписчик';
    if ([2,3,4].includes(n10) && ![12,13,14].includes(n100)) return n + ' подписчика';
    return n + ' подписчиков';
  }

  // Получить текущего пользователя из Chat
  function currentUser() {
    return window.Chat && window.Chat._currentUser ? window.Chat._currentUser : null;
  }

  // ---- Кэш подписок пользователей ----
  async function loadUserSubscriptions(userIds) {
    if (!userIds || userIds.length === 0) return;
    const uncached = userIds.filter(id => !(id in userSubsCache));
    if (uncached.length === 0) return;
    try {
      const { data } = await sb().rpc('get_subscriptions_for_users', { p_user_ids: uncached });
      // Заполняем кэш найденными
      if (data) {
        data.forEach(row => { userSubsCache[row.user_id] = row.plan; });
      }
      // Для тех кого не нашли — план 'none'
      uncached.forEach(id => { if (!(id in userSubsCache)) userSubsCache[id] = 'none'; });
    } catch {
      uncached.forEach(id => { userSubsCache[id] = 'none'; });
    }
  }

  function getUsernamePlanClass(userId) {
    const plan = userSubsCache[userId] || 'none';
    if (plan === 'pro') return 'username-pro';
    if (plan === 'plus') return 'username-plus';
    return '';
  }

  // ============================================================
  // 1. ЗАГРУЗКА КАНАЛОВ
  // ============================================================
  // ---- Автоматическое вступление в официальный канал IFlash ----
  async function _ensureIFlashChannel() {
    const user = currentUser();
    if (!user) return;
    try {
      // Ищем официальный канал IFlash по имени
      const { data: iflashCh } = await sb()
        .from('channels')
        .select('id, name')
        .ilike('name', 'iflash')
        .maybeSingle();
      if (!iflashCh) return;
      // Уже состоит?
      if (channels.some(c => c.id === iflashCh.id)) return;
      // Добавляем пользователя как участника
      await sb().from('channel_members').upsert({
        channel_id: iflashCh.id,
        user_id: user.id,
        role: 'member',
      }, { onConflict: 'channel_id,user_id', ignoreDuplicates: true });
    } catch (e) {
      console.warn('[Channels] _ensureIFlashChannel error:', e);
    }
  }

  async function loadChannels() {
    const user = currentUser();
    if (!user) return;
    try {
      // Сначала убеждаемся что пользователь состоит в канале IFlash
      await _ensureIFlashChannel();

      const { data, error } = await sb().rpc('get_my_channels');
      if (!error && data) {
        channels = data;
        return;
      }
      console.warn('[Channels] rpc error:', error?.message);
      // Fallback: прямой запрос
      const { data: memRows } = await sb()
        .from('channel_members')
        .select('channel_id, role, muted')
        .eq('user_id', user.id);
      if (memRows && memRows.length > 0) {
        const ids = memRows.map(r => r.channel_id);
        const { data: ch } = await sb().from('channels').select('*').in('id', ids);
        channels = (ch || []).map(c => {
          const mem = memRows.find(r => r.channel_id === c.id) || {};
          return { ...c, my_role: mem.role || 'member', muted: mem.muted || false, member_count: null };
        });
      } else {
        channels = [];
      }
    } catch (e) {
      console.error('[Channels] loadChannels error:', e);
      channels = [];
    }
  }

  // Загрузка непрочитанных для каналов (после loadChannels)
  async function _loadChannelUnreadCounts() {
    const user = currentUser();
    if (!user || !channels.length) return;
    channelUnreadMap = {};
    for (const ch of channels) {
      const lastRead = localStorage.getItem(`ch_last_read_${ch.id}`);
      if (!lastRead) continue;
      try {
        const { count } = await sb()
          .from('channel_messages')
          .select('id', { count: 'exact', head: true })
          .eq('channel_id', ch.id)
          .gt('created_at', lastRead);
        if (count > 0) channelUnreadMap[ch.id] = count;
      } catch {}
    }
  }

  // ============================================================
  // 2. РЕНДЕР КАНАЛОВ В САЙДБАРЕ
  // ============================================================
  function renderChannelsInList(container) {
    // Убираем старые
    container.querySelectorAll('.conv-channel-item').forEach(el => el.remove());
    if (!channels || channels.length === 0) return;

    // Закреплённые каналы — первыми; канал IFlash — всегда самым первым
    const pinnedChannels = JSON.parse(localStorage.getItem('iflash_pinned_channels') || '[]');
    const sortedChannels = [...channels].sort((a, b) => {
      const aIsIFlash = a.name.toLowerCase() === 'iflash';
      const bIsIFlash = b.name.toLowerCase() === 'iflash';
      if (aIsIFlash && !bIsIFlash) return -1;
      if (!aIsIFlash && bIsIFlash) return 1;
      const aPin = pinnedChannels.indexOf(a.id);
      const bPin = pinnedChannels.indexOf(b.id);
      if (aPin !== -1 && bPin === -1) return -1;
      if (aPin === -1 && bPin !== -1) return 1;
      if (aPin !== -1 && bPin !== -1) return aPin - bPin;
      return 0;
    });
    const firstChild = container.firstChild;
    // Строим через DocumentFragment — правильный порядок (закреплённые первыми)
    const chFragment = document.createDocumentFragment();
    sortedChannels.forEach(ch => {
      const isActive = selectedChannel && selectedChannel.id === ch.id;
      const div = document.createElement('div');
      div.className = `conversation-item conv-channel-item${isActive ? ' active' : ''}`;
      div.dataset.channelId = ch.id;
      div.onclick = () => openChannelChat(ch);

      const avatarHTML = ch.avatar_url
        ? `<div class="conv-channel-avatar"><img src="${escHTML(ch.avatar_url)}" alt=""></div>`
        : `<div class="conv-channel-avatar">📢</div>`;

      const muteIcon = ch.muted ? ' 🔇' : '';
      const pinIcon = pinnedChannels.includes(ch.id) ? ' 📌' : '';

      const verBadge = (window.IFlashSub && window.IFlashSub.isVerifiedChannel(ch.id))
        ? window.IFlashSub.verifiedBadgeHTML() : '';

      const chUnread = channelUnreadMap[ch.id] || 0;
      div.innerHTML = `
        ${avatarHTML}
        <div class="conv-info">
          <div class="conv-header">
            <span class="conv-name" style="display:flex;align-items:center;gap:2px;">${escHTML(ch.name)}${verBadge}${muteIcon}${pinIcon}</span>
            ${chUnread > 0 ? `<span class="unread-badge">${chUnread}</span>` : '<span class="conv-channel-tag">Канал</span>'}
          </div>
          <div class="conv-preview">
            <span class="conv-text">${ch.description ? escHTML(_cleanDescription(ch.description)) : (ch.is_public ? 'Публичный канал' : 'Приватный канал')}</span>
          </div>
        </div>
      `;
      chFragment.appendChild(div);
    });
    container.insertBefore(chFragment, firstChild);
  }

  // ============================================================
  // 3. ОТКРЫТЬ КАНАЛ
  // ============================================================
  async function openChannelChat(ch) {
    // ── Инвалидируем предыдущую загрузку канала ──
    const chGen = ++_channelLoadGen;

    selectedChannel = ch;
    // Сбрасываем счётчик непрочитанных канала
    channelUnreadMap[ch.id] = 0;
    localStorage.setItem(`ch_last_read_${ch.id}`, new Date().toISOString());
    // Сбрасываем другие активные чаты
    if (window.Chat) {
      window.Chat._clearSelection && window.Chat._clearSelection();
      // Скрываем кнопку «Цифровая вежливость» — она только для личных чатов
      window.Chat.updateSendOnlineBtn && window.Chat.updateSendOnlineBtn();
    }
    // Убираем кнопку «Старт» бота если вдруг осталась
    const botStartPanel = document.getElementById('bot-start-panel');
    if (botStartPanel) botStartPanel.remove();
    // Восстанавливаем видимость поля ввода (потом скроем ниже под канал)
    const _inputArea = document.querySelector('.chat-input-area');
    if (_inputArea) _inputArea.style.display = '';

    // Подсветка в сайдбаре
    document.querySelectorAll('.conversation-item').forEach(el => el.classList.remove('active'));
    const activeEl = document.querySelector(`.conversation-item[data-channel-id="${ch.id}"]`);
    if (activeEl) activeEl.classList.add('active');

    // Получить кол-во участников (если ещё не загружено)
    let memberCount = ch.member_count;
    if (memberCount === null || memberCount === undefined) {
      try {
        const { data: cnt } = await sb().rpc('get_channel_member_count', { p_channel_id: ch.id });
        memberCount = cnt || 0;
        // Обновляем в массиве
        const idx = channels.findIndex(c => c.id === ch.id);
        if (idx !== -1) channels[idx].member_count = memberCount;
        selectedChannel = { ...selectedChannel, member_count: memberCount };
      } catch { memberCount = 0; }
    }

    // Определить: вступил ли пользователь в канал
    const isMember = channels.some(c => c.id === ch.id);
    const isAdmin = isMember && (channels.find(c => c.id === ch.id)?.my_role === 'admin');

    // Рендер шапки
    renderChannelHeader(ch, memberCount, isMember, isAdmin);

    // Показываем область чата
    const welcome = getEl('welcome-screen');
    const chatArea = getEl('chat-area');
    const stranger = getEl('stranger-banner');
    const blocked = getEl('blocked-screen');
    const msgContainer = getEl('messages-container');
    const inputArea = document.querySelector('.chat-input-area');
    const pinBar = getEl('pin-bar');

    if (welcome) welcome.style.display = 'none';
    if (chatArea) { chatArea.style.display = 'flex'; chatArea.style.flexDirection = 'column'; }
    if (stranger) stranger.style.display = 'none';
    if (blocked) blocked.style.display = 'none';
    if (pinBar) pinBar.style.display = 'none';
    if (msgContainer) {
      msgContainer.style.display = '';
      msgContainer.classList.remove('chat-enter');
      void msgContainer.offsetWidth;
      msgContainer.classList.add('chat-enter');
      msgContainer.addEventListener('animationend', () => msgContainer.classList.remove('chat-enter'), { once: true });
    }

    // Нижняя панель: скрываем обычный ввод, показываем панель канала
    if (inputArea) inputArea.style.display = 'none';
    renderChannelFooter(ch, isMember, isAdmin);

    // Мобильный режим
    const sidebar = document.querySelector('.sidebar');
    const mainChat = document.querySelector('.main-chat');
    if (window.innerWidth <= 768) {
      if (sidebar) sidebar.classList.add('hidden-mobile');
      if (mainChat) mainChat.classList.add('visible-mobile');
    }

    // Загружаем закреплённые сообщения
    _loadPinnedMessages(ch.id);

    // Загружаем сообщения и опросы
    await loadChannelMessages(ch.id);
    await loadChannelPolls(ch.id);

    // Отрисовываем панель закреплённых
    _renderPinnedBar();

    // Загружаем и подписываемся на реакции канала
    await _loadChReactionsForChannel(ch.id);
    // Рендерим реакции для всех сообщений
    document.querySelectorAll('.chmsg-wrapper[data-msg-id]').forEach(w => {
      _renderChReactions(w.dataset.msgId);
    });
    _subscribeToChReactions(ch.id);

    // Realtime-подписка
    if (channelRealtimeSub) {
      try { sb().removeChannel(channelRealtimeSub); } catch {}
    }
    channelRealtimeSub = sb()
      .channel('channel_messages_' + ch.id)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public',
        table: 'channel_messages',
        filter: `channel_id=eq.${ch.id}`
      }, payload => {
        if (selectedChannel && selectedChannel.id === ch.id) {
          appendChannelMessage(payload.new);
        }
      })
      .on('postgres_changes', {
        event: 'DELETE', schema: 'public',
        table: 'channel_messages',
        filter: `channel_id=eq.${ch.id}`
      }, payload => {
        const msgId = payload.old?.id;
        if (msgId) {
          const el = document.querySelector(`[data-msg-id="${msgId}"]`);
          if (el) el.remove();
        }
      })
      .subscribe();
  }

  // ---- Рендер шапки канала ----
  function renderChannelHeader(ch, memberCount, isMember, isAdmin) {
    const headerEl = getEl('chat-header-content');
    if (!headerEl) return;

    const cnt = memberCount !== null && memberCount !== undefined ? pluralMembers(memberCount) : '';
    const avatarHTML = ch.avatar_url
      ? `<div class="channel-chat-header-avatar"><img src="${escHTML(ch.avatar_url)}" alt=""></div>`
      : `<div class="channel-chat-header-avatar">📢</div>`;

    const typeLabel = ch.is_public ? 'Публичный' : '🔒 Приватный';

    // Mute-кнопка (только если вступил)
    let muteBtn = '';
    if (isMember) {
      const isMuted = channels.find(c => c.id === ch.id)?.muted || false;
      muteBtn = `
        <button class="channel-header-btn ${isMuted ? 'muted' : ''}" onclick="Channels.toggleChannelMute('${escHTML(ch.id)}')" title="${isMuted ? 'Включить уведомления' : 'Отключить уведомления'}">
          ${isMuted
            ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`
            : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`
          }
        </button>`;
    }

    // Кнопки только для admin — вынесены в меню 3 точки
    let moreBtn = '';
    if (isAdmin) {
      moreBtn = `
        <button class="channel-more-btn" onclick="Channels._openChannelMoreMenu(event,'${escHTML(ch.id)}')" title="Дополнительно">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
          </svg>
        </button>`;
    }

    const verifiedBadge = (window.IFlashSub && window.IFlashSub.isVerifiedChannel(ch.id))
      ? window.IFlashSub.verifiedBadgeHTML() : '';

    headerEl.innerHTML = `
      <button class="back-btn" onclick="${window.Chat ? 'Chat.goBackToList()' : ''}" title="Назад">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      </button>
      <div class="channel-chat-header" onclick="Channels.openChannelInfo()">
        ${avatarHTML}
        <div class="channel-chat-header-info">
          <span class="channel-chat-header-name" style="display:flex;align-items:center;gap:2px;">${escHTML(ch.name)}${verifiedBadge}</span>
          <span class="channel-chat-header-meta">
            <span class="channel-header-badge">${typeLabel}</span>
            ${cnt ? `<span>${cnt}</span>` : ''}
          </span>
        </div>
      </div>
      <div class="channel-header-actions">
        ${moreBtn}
        ${muteBtn}
      </div>
    `;
  }

  // ---- Меню 3 точки для администратора канала ----
  function _openChannelMoreMenu(e, channelId) {
    e.stopPropagation();
    document.querySelectorAll('.channel-more-dropdown').forEach(m => m.remove());

    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'channel-more-dropdown';

    // Подсчитать запланированные
    const scheduled = _getScheduledMessages(channelId);
    const pendingCount = scheduled.filter(m => !m.sent).length;
    const scheduledHint = pendingCount > 0
      ? `<span style="margin-left:auto;background:var(--accent-color,#6c63ff);color:#fff;font-size:11px;padding:2px 7px;border-radius:10px;">${pendingCount}</span>`
      : '';

    menu.innerHTML = `
      <button class="channel-more-item" onclick="Channels.generateChannelInviteLink('${escHTML(channelId)}');document.querySelectorAll('.channel-more-dropdown').forEach(m=>m.remove())">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        Пригласительная ссылка
      </button>
      <button class="channel-more-item" onclick="Channels.openCreatePollModal();document.querySelectorAll('.channel-more-dropdown').forEach(m=>m.remove())">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8M8 8h5M8 16h3"/></svg>
        Создать опрос
      </button>
      <button class="channel-more-item" onclick="Channels.openScheduledSendModal('${escHTML(channelId)}');document.querySelectorAll('.channel-more-dropdown').forEach(m=>m.remove())">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        Отложенная отправка
        ${scheduledHint}
      </button>
      ${pendingCount > 0 ? `
      <button class="channel-more-item" onclick="Channels.openScheduledMessagesManager('${escHTML(channelId)}');document.querySelectorAll('.channel-more-dropdown').forEach(m=>m.remove())" style="color:var(--accent-color,#6c63ff);">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Управление (${pendingCount})
      </button>` : ''}
    `;

    document.body.appendChild(menu);
    // Позиционирование
    menu.style.left = '0'; menu.style.top = '-9999px';
    requestAnimationFrame(() => {
      let x = rect.right - menu.offsetWidth;
      let y = rect.bottom + 6;
      if (x < 8) x = 8;
      if (y + menu.offsetHeight > window.innerHeight - 8) y = rect.top - menu.offsetHeight - 6;
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
    });

    const close = (ev) => {
      if (!menu.contains(ev.target) && !btn.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 50);
  }

  // ---- Нижняя панель канала ----
  function renderChannelFooter(ch, isMember, isAdmin) {
    // Удаляем старую панель если есть
    const old = document.getElementById('channel-footer-panel');
    if (old) old.remove();

    const chatArea = getEl('chat-area');
    if (!chatArea) return;

    // Для admin: показываем обычный input area вместо нашей панели
    if (isAdmin) {
      const inputArea = document.querySelector('.chat-input-area');
      if (inputArea) inputArea.style.display = '';
      // Скрываем «Цифровую вежливость» — в каналах не нужна
      const swoBtn = document.getElementById('send-online-btn');
      if (swoBtn) swoBtn.style.display = 'none';
      return; // Используем стандартный input
    }

    const footer = document.createElement('div');
    footer.id = 'channel-footer-panel';
    footer.className = 'channel-footer';

    if (!isMember) {
      // Кнопка вступить (только для публичных; для приватных — нет)
      if (ch.is_public) {
        footer.innerHTML = `
          <button class="channel-join-btn" onclick="Channels.joinPublicChannel('${escHTML(ch.id)}')">
            ✚ Вступить в канал
          </button>
        `;
      } else {
        footer.innerHTML = `
          <span class="channel-subscriber-hint">🔒 Приватный канал. Вступить можно только по ссылке-приглашению.</span>
        `;
      }
    } else {
      // Уже участник — только mute/unmute (кнопка комментариев — под каждым постом)
      const isMuted = channels.find(c => c.id === ch.id)?.muted || false;
      footer.innerHTML = `
        <span class="channel-subscriber-hint">Вы подписаны на этот канал</span>
        <button class="channel-mute-btn" onclick="Channels.toggleChannelMute('${escHTML(ch.id)}')">
          ${isMuted
            ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg> Включить звук`
            : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> Отключить звук`
          }
        </button>
      `;
    }

    chatArea.appendChild(footer);
  }

  // ============================================================
  // 4. СООБЩЕНИЯ КАНАЛА
  // ============================================================
  async function loadChannelMessages(channelId) {
    // ── Захватываем поколение канала на момент вызова ──
    const gen = _channelLoadGen;

    const container = getEl('messages-container');
    if (!container) return;
    container.innerHTML = `
      <div class="messages-loading">
        <div class="loading-spinner"></div>
        <span>Загрузка сообщений...</span>
      </div>`;

    try {
      const { data, error } = await sb()
        .from('channel_messages')
        .select('*')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: true })
        .limit(100);

      // Проверяем — вдруг переключились на другой канал пока шёл запрос
      if (gen !== _channelLoadGen) return;

      if (error) {
        container.innerHTML = `<div class="messages-error">Ошибка загрузки: ${escHTML(error.message)}</div>`;
        return;
      }

      container.innerHTML = '';

      // Предзагружаем подписки отправителей для анимированных ников
      if (data && data.length > 0) {
        const senderIds = [...new Set(data.map(m => m.sender_id).filter(Boolean))];
        await loadUserSubscriptions(senderIds);
        if (gen !== _channelLoadGen) return; // проверяем после async
      }

      if (!data || data.length === 0) {
        if (gen !== _channelLoadGen) return;
        container.innerHTML = `
          <div class="no-messages">
            <div class="no-messages-icon">📢</div>
            <p>В этом канале ещё нет сообщений</p>
          </div>`;
        return;
      }

      // Группируем по дате
      let lastDate = null;
      for (const msg of data) {
        const msgDate = new Date(msg.created_at).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });
        if (msgDate !== lastDate) {
          lastDate = msgDate;
          const divider = document.createElement('div');
          divider.className = 'chmsg-date-divider';
          divider.textContent = msgDate;
          container.appendChild(divider);
        }
        appendChannelMessage(msg, false);
      }
      container.scrollTop = container.scrollHeight;
    } catch (e) {
      console.error('[Channels] loadChannelMessages error:', e);
    }
  }

  // Добавить сообщение в контейнер
  function appendChannelMessage(msg, scroll = true) {
    const container = getEl('messages-container');
    if (!container) return;

    // Очистить empty-state
    const empty = container.querySelector('.no-messages');
    if (empty) empty.remove();

    // Имя канала как отправитель (без аватарки)
    const senderName = selectedChannel ? (selectedChannel.name || 'Канал') : 'Канал';
    const avatarHTML = '';

    const time = fmtDate(msg.created_at);

    // Парсинг пересланного сообщения (канал, группа, пользователь)
    const fwdMatchCh = msg.content && msg.content.match(/^↪ Переслано из канала «(.+?)»\n?([\s\S]*)$/);
    const fwdMatchGr = msg.content && msg.content.match(/^↪ Переслано из группы «(.+?)»\n?([\s\S]*)$/);
    const fwdMatchUs = msg.content && msg.content.match(/^↪ Переслано от (.+?)\n([\s\S]*)$/);
    let fwdHeaderHTML = '';
    let displayContent = msg.content;
    if (fwdMatchCh) {
      displayContent = fwdMatchCh[2] || '';
      fwdHeaderHTML = `<div class="ch-forwarded-header"><span class="ch-fwd-icon">📢</span><span class="ch-fwd-text">↪ Переслано из канала <b>${escHTML(fwdMatchCh[1])}</b></span></div>`;
    } else if (fwdMatchGr) {
      displayContent = fwdMatchGr[2] || '';
      fwdHeaderHTML = `<div class="ch-forwarded-header"><span class="ch-fwd-icon">👥</span><span class="ch-fwd-text">↪ Переслано из группы <b>${escHTML(fwdMatchGr[1])}</b></span></div>`;
    } else if (fwdMatchUs) {
      displayContent = fwdMatchUs[2] || '';
      fwdHeaderHTML = `<div class="ch-forwarded-header"><span class="ch-fwd-icon">💬</span><span class="ch-fwd-text">↪ Переслано от <b>${escHTML(fwdMatchUs[1])}</b></span></div>`;
    }

    // Тело сообщения: СНАЧАЛА ФАЙЛ, потом текст
    let bodyHTML = '';
    function _renderChFileItem(url, name, type, size) {
      if (type && type.startsWith('image/')) {
        return `<img src="${escHTML(url)}" style="max-width:260px;border-radius:10px;margin-bottom:4px;cursor:pointer;" onclick="if(window.Chat)Chat.openImageModal('${escHTML(url)}')">`;
      } else if (name && name.startsWith('vidnote_')) {
        const uid = `vn-ch-${msg.id}-${Math.random().toString(36).slice(2,6)}`;
        return `
          <div class="vidnote-wrap" id="${uid}" style="margin-top:4px;">
            <div class="vidnote-clickable" onclick="Chat.toggleVidnote('${uid}')">
              <div class="vidnote-canvas-wrap">
                <video class="vidnote-video" id="${uid}-video" src="${escHTML(url)}" preload="metadata" playsinline
                  onloadedmetadata="Chat.onVidnoteMetaLoaded('${uid}')"></video>
                <svg class="vidnote-ring-svg" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4.5"/>
                  <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="4.5" stroke-linecap="round"
                    stroke-dasharray="289 289" stroke-dashoffset="289" id="${uid}-progress"
                    style="transform:rotate(-90deg);transform-origin:50% 50%;"/>
                </svg>
                <div class="vidnote-play-icon" id="${uid}-playicon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="6,3 20,12 6,21"/></svg>
                </div>
              </div>
            </div>
            <span class="vidnote-dur" id="${uid}-dur">Кружок</span>
          </div>`;
      } else if (type && (type.startsWith('audio/') || type.includes('webm') || type.includes('ogg'))) {
        const uid = `voice-ch-${msg.id}-${Math.random().toString(36).slice(2,6)}`;
        return `
          <div class="msg-voice">
            <button class="msg-voice-play" onclick="Chat.toggleMsgVoice('${uid}')" title="Воспроизвести">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" id="${uid}-icon"><polygon points="5,3 19,12 5,21"/></svg>
            </button>
            <div class="msg-voice-track">
              <input type="range" class="msg-voice-seek" id="${uid}-seek" min="0" max="100" value="0" step="0.1" oninput="Chat.seekMsgVoice('${uid}')">
              <div class="msg-voice-fill-bg"><div class="msg-voice-fill" id="${uid}-fill"></div></div>
            </div>
            <span class="msg-voice-dur" id="${uid}-dur">0:00</span>
            <audio id="${uid}-audio" src="${escHTML(url)}" preload="metadata" style="display:none;"
              onloadedmetadata="Chat.onVoiceMetaLoaded('${uid}')"
              ontimeupdate="Chat.onVoiceTimeUpdate('${uid}')"
              onended="Chat.onVoiceEnded('${uid}')"></audio>
          </div>`;
      } else {
        const sizeStr = size ? ` · ${window.Chat && window.Chat._formatFileSize ? window.Chat._formatFileSize(size) : ''}` : '';
        return `<a href="${escHTML(url)}" target="_blank" class="file-link" style="display:block;margin-bottom:4px;">📎 ${escHTML(name || 'Файл')}${escHTML(sizeStr)}</a>`;
      }
    }
    if (msg.file_url) {
      if (msg.file_type === 'multi') {
        // Мульти-файл: несколько вложений в одном сообщении
        try {
          const files = JSON.parse(msg.file_url);
          files.forEach(f => { bodyHTML += _renderChFileItem(f.url, f.name, f.type, f.size); });
        } catch {
          bodyHTML += `<a href="#" class="file-link">📎 Медиагруппа</a>`;
        }
      } else if (msg.file_type && msg.file_type.startsWith('image/')) {
        bodyHTML += _renderChFileItem(msg.file_url, msg.file_name, msg.file_type, msg.file_size);
      } else if (msg.file_name && msg.file_name.startsWith('vidnote_')) {
        bodyHTML += _renderChFileItem(msg.file_url, msg.file_name, msg.file_type, msg.file_size);
      } else if (msg.file_type && (msg.file_type.startsWith('audio/') || msg.file_type.includes('webm') || msg.file_type.includes('ogg'))) {
        bodyHTML += _renderChFileItem(msg.file_url, msg.file_name, msg.file_type, msg.file_size);
      } else {
        bodyHTML += _renderChFileItem(msg.file_url, msg.file_name, msg.file_type, msg.file_size);
      }
    }
    // Текст ПОСЛЕ файла — с полным форматированием (жирный, курсив, ссылки, спойлеры и т.д.)
    if (displayContent) {
      if (displayContent.length > CH_COLLAPSE_LIMIT) {
        const previewFmt = _chFormatText(displayContent.slice(0, CH_COLLAPSE_PREVIEW));
        const restFmt    = _chFormatText(displayContent.slice(CH_COLLAPSE_PREVIEW));
        const colId = `ch-collapse-${msg.id}`;
        bodyHTML += `<div class="chmsg-text">
          <span>${previewFmt}<span id="${colId}-ellipsis">...</span></span>
          <span id="${colId}" style="display:none;">${restFmt}</span>
          <br><button class="msg-collapse-btn" onclick="(function(el,btn){var s=document.getElementById('${colId}');var e=document.getElementById('${colId}-ellipsis');if(!s)return;var c=s.style.display==='none';s.style.display=c?'inline':'none';if(e)e.style.display=c?'none':'inline';btn.textContent=c?'Свернуть':'Развернуть';})(this,this)">Развернуть</button>
        </div>`;
      } else {
        bodyHTML += `<div class="chmsg-text">${_chFormatText(displayContent)}</div>`;
      }
    }

    // Если это инвайт-ссылка канала — рендерим карточку
    const channelInviteMatch = msg.content && msg.content.match(/^IFlashCHANNEL_([0-9a-f-]{36})$/);
    if (channelInviteMatch) {
      const invChId = channelInviteMatch[1];
      const wrapper = document.createElement('div');
      wrapper.className = 'chmsg-wrapper';
      wrapper.dataset.msgId = msg.id;
      wrapper.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:10px;max-width:75%;">
          ${avatarHTML}
          <div>
            <div class="chmsg-sender">${escHTML(senderName)}</div>
            <div class="msg-text group-invite-link" onclick="Channels.handleChannelInviteClick('${invChId}')" title="Нажмите, чтобы вступить в канал" style="cursor:pointer;">
              <span class="group-invite-icon">📢</span>
              <div>
                <span class="group-invite-text">Приглашение в канал</span>
                <span class="group-invite-sub">Нажмите, чтобы вступить</span>
              </div>
            </div>
          </div>
        </div>
      `;
      container.appendChild(wrapper);
      if (scroll) container.scrollTop = container.scrollHeight;
      return;
    }

    const user = currentUser();
    const isAdmin = user && channels.find(c => c.id === selectedChannel?.id)?.my_role === 'admin';

    // Анимированный ник по подписке
    const planClass = msg.sender_id ? getUsernamePlanClass(msg.sender_id) : '';
    const senderNameHTML = planClass
      ? `<span class="${planClass}">${escHTML(senderName)}</span>`
      : escHTML(senderName);

    const wrapper = document.createElement('div');
    wrapper.className = 'chmsg-wrapper';
    wrapper.dataset.msgId = msg.id;
    // Плашка ответа в канале
    let chReplyPlateHTML = '';
    if (msg.reply_to) {
      const rText = msg.reply_text || '';
      const qText = msg.quote_text || '';
      const trunc = (qText || rText).length > 50 ? (qText || rText).slice(0, 50) + '…' : (qText || rText);
      const isQ = !!qText;
      chReplyPlateHTML = `
        <div class="reply-plate ${isQ ? 'reply-plate-quote' : ''}" data-reply-id="${escHTML(msg.reply_to)}" onclick="Chat.scrollToMessage('${escHTML(msg.reply_to)}', ${isQ ? "'" + escHTML(qText).replace(/'/g, "\\'") + "'" : 'null'})">
          <div class="reply-plate-line"></div>
          <div class="reply-plate-content">
            <span class="reply-plate-label">${isQ ? '❝ Цитата' : '↩ Ответ'}</span>
            <span class="reply-plate-text">${escHTML(trunc)}</span>
          </div>
        </div>`;
    }

    wrapper.innerHTML = `
      <div class="chmsg-card">
        <div class="chmsg-sender">${senderNameHTML}</div>
        ${chReplyPlateHTML}
        ${fwdHeaderHTML}
        ${bodyHTML}
        ${_buildChReactionBar(msg.id)}
        <div class="chmsg-comments-divider" id="chmsg-cdiv-${escHTML(msg.id)}" style="display:none;"></div>
        <div class="chmsg-post-actions" id="chmsg-pact-${escHTML(msg.id)}"></div>
        <div class="chmsg-meta">
          <span class="chmsg-time">${time}</span>
        </div>
      </div>
    `;

    // Инициализируем кэш реакций
    if (!chReactionsCache[msg.id]) chReactionsCache[msg.id] = {};

    // Кнопка комментариев под постом (если включены)
    const commData = selectedChannel ? _getCommentsData(selectedChannel.id) : null;
    if (commData && commData.groupId && commData.enabled) {
      // Показываем разделитель
      const cdiv = wrapper.querySelector(`#chmsg-cdiv-${msg.id}`);
      if (cdiv) cdiv.style.display = '';
      const pact = wrapper.querySelector(`#chmsg-pact-${msg.id}`);
      if (pact) {
        pact.innerHTML = `
          <button class="chmsg-comments-btn" data-post-id="${escHTML(msg.id)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <span>Комментарии</span>
            <span class="chmsg-cc" id="chmsg-cc-${escHTML(msg.id)}">0</span>
          </button>
        `;
        pact.querySelector('.chmsg-comments-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          _openPostComments(msg.id, wrapper);
        });
      }
    }

    // Контекстное меню сообщения канала (БЕЗ реакции — она на hover-кнопке)
    wrapper.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      document.querySelectorAll('.channel-msg-ctx-menu').forEach(m => m.remove());
      const msgContent = displayContent || '';
      const menu = document.createElement('div');
      menu.className = 'msg-context-menu channel-msg-ctx-menu';
      const chSelection = window.getSelection();
      const chHasQuote = chSelection && chSelection.toString().trim().length > 0;
      const chQuoteText = chHasQuote ? chSelection.toString().trim() : '';
      menu.innerHTML = `
        ${isAdmin ? `<button class="msg-ctx-item" data-action="reply">↩ Ответить</button>` : ''}
        ${isAdmin && chHasQuote ? `<button class="msg-ctx-item" data-action="quote-reply">❝ Ответить с цитатой</button>` : ''}
        ${msgContent && !msgContent.match(/^IFlashCHANNEL_/) ? `
        <button class="msg-ctx-item" data-action="copy">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Копировать текст
        </button>
        <button class="msg-ctx-item" data-action="select">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg>
          Выделить текст
        </button>` : ''}
        <button class="msg-ctx-item" data-action="forward">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>
          Переслать
        </button>
        ${isAdmin ? `
        <button class="msg-ctx-item" data-action="pin">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 2h6l-1.5 5H12h-1.5L9 2z"/><path d="M5.5 12H18.5L17 7H7L5.5 12z"/></svg>
          ${_isPinned(msg.id) ? 'Открепить' : 'Закрепить'}
        </button>
        <button class="msg-ctx-item msg-ctx-item--danger" data-action="delete">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          Удалить
        </button>` : ''}
      `;
      document.body.appendChild(menu);

      let mx = e.clientX, my = e.clientY;
      menu.style.left = '0'; menu.style.top = '-9999px';
      requestAnimationFrame(() => {
        const mh = menu.offsetHeight, mw = menu.offsetWidth;
        if (mx + mw > window.innerWidth - 8) mx = window.innerWidth - mw - 8;
        if (my + mh > window.innerHeight - 8) my = my - mh - 8;
        menu.style.left = mx + 'px'; menu.style.top = my + 'px';
      });

      menu.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          menu.remove();
          if (action === 'reply') {
            if (window.Chat) {
              const sName = selectedChannel ? selectedChannel.name : 'Канал';
              const sAvatar = selectedChannel ? selectedChannel.avatar_url : null;
              window.Chat.cancelReply();
              // Use Chat's reply system
              const replyBanner = document.getElementById('reply-banner');
              if (replyBanner) {
                replyBanner.style.display = 'flex';
                const truncText = msgContent.length > 30 ? msgContent.slice(0, 30) + '…' : msgContent;
                replyBanner.innerHTML = `
                  <div class="reply-banner-line"></div>
                  <div class="reply-banner-content">
                    <div class="reply-banner-header">
                      <span class="reply-banner-name">${escHTML(sName)}</span>
                    </div>
                    <div class="reply-banner-text">${escHTML(truncText)}</div>
                  </div>
                  <button class="reply-banner-close" onclick="Chat.cancelReply()" title="Отменить">✕</button>
                `;
              }
              // Store reply data for channel send
              _channelReplyTo = { msgId: msg.id, text: msgContent, quoteText: null };
            }
          } else if (action === 'quote-reply') {
            if (window.Chat) {
              const replyBanner = document.getElementById('reply-banner');
              if (replyBanner) {
                replyBanner.style.display = 'flex';
                const truncText = chQuoteText.length > 30 ? chQuoteText.slice(0, 30) + '…' : chQuoteText;
                replyBanner.innerHTML = `
                  <div class="reply-banner-line" style="background:#ffc107;"></div>
                  <div class="reply-banner-content">
                    <div class="reply-banner-header">
                      <span class="reply-banner-name" style="color:#ffc107;">❝ Цитата</span>
                    </div>
                    <div class="reply-banner-text">${escHTML(truncText)}</div>
                  </div>
                  <button class="reply-banner-close" onclick="Chat.cancelReply();Channels._channelReplyTo=null;" title="Отменить">✕</button>
                `;
              }
              _channelReplyTo = { msgId: msg.id, text: '', quoteText: chQuoteText };
            }
          } else if (action === 'copy') {
            navigator.clipboard.writeText(msgContent).then(() => toast('Скопировано', 'success'));
          } else if (action === 'select') {
            const textEl = wrapper.querySelector('.chmsg-text');
            if (textEl) {
              const range = document.createRange();
              range.selectNodeContents(textEl);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            }
          } else if (action === 'forward') {
            _showChannelForwardModal(msg, selectedChannel);
          } else if (action === 'pin') {
            _togglePin(msg.id, displayContent || '');
          } else if (action === 'delete') {
            deleteChannelMessage(msg.id);
          }
        });
      });

      const closeMenu = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', closeMenu); } };
      setTimeout(() => document.addEventListener('mousedown', closeMenu), 50);
    });

    container.appendChild(wrapper);

    // Рендерим реакции ПОСЛЕ добавления в DOM
    _renderChReactions(msg.id);
    // Обновляем счётчик комментариев ПОСЛЕ добавления в DOM
    if (commData && commData.groupId) {
      _updateCommentCount(msg.id, commData.groupId);
    }

    if (scroll) container.scrollTop = container.scrollHeight;
  }

  // Удалить сообщение канала (только admins)
  async function deleteChannelMessage(msgId) {
    if (!confirm('Удалить сообщение?')) return;
    try {
      await sb().from('channel_messages').delete().eq('id', msgId);
      const el = document.querySelector(`[data-msg-id="${msgId}"]`);
      if (el) el.remove();
    } catch (e) {
      toast('Ошибка удаления', 'error');
    }
  }

  // Отправить сообщение в канал (только admins)
  async function sendChannelMessage() {
    const user = currentUser();
    if (!user || !selectedChannel) return;
    const isAdmin = channels.find(c => c.id === selectedChannel.id)?.my_role === 'admin';
    if (!isAdmin) { toast('Только администраторы могут писать в канал', 'error'); return; }

    const input = getEl('message-input');
    const content = input ? input.value.trim() : '';

    // Получаем выбранные файлы через chat.js
    const selectedFiles = window.Chat && window.Chat._getSelectedFiles ? window.Chat._getSelectedFiles() : [];
    const legacyFile = window.Chat && window.Chat._getSelectedFile ? window.Chat._getSelectedFile() : null;
    const files = selectedFiles.length > 0 ? selectedFiles : (legacyFile ? [legacyFile] : []);

    if (!content && files.length === 0) return;

    const sendBtn = getEl('send-btn');
    if (sendBtn) sendBtn.disabled = true;

    try {
      // Если есть файлы — все файлы объединяем в ОДНО сообщение (JSON в file_url при multiple)
      if (files.length > 0) {
        const MAX_SIZE = 25 * 1024 * 1024;
        const uploaded = [];
        for (const file of files) {
          if (file.size > MAX_SIZE) { toast(`Файл «${file.name}» слишком большой (макс 25 МБ)`, 'error'); continue; }
          const ext = file.name.split('.').pop();
          const filePath = `${user.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
          const { error: upErr } = await sb().storage
            .from('chat-files').upload(filePath, file, { cacheControl: '3600', upsert: false });
          if (upErr) { toast('Ошибка загрузки файла: ' + file.name, 'error'); continue; }
          const { data: urlData } = sb().storage.from('chat-files').getPublicUrl(filePath);
          uploaded.push({ url: urlData.publicUrl, name: file.name, type: file.type, size: file.size });
        }
        if (uploaded.length === 0) { if (window.Chat && window.Chat.clearSelectedFile) window.Chat.clearSelectedFile(); return; }

        let msgPayload;
        if (uploaded.length === 1) {
          // Один файл — обычный формат
          msgPayload = {
            channel_id: selectedChannel.id, sender_id: user.id,
            content: content || null,
            file_url: uploaded[0].url, file_name: uploaded[0].name,
            file_type: uploaded[0].type, file_size: uploaded[0].size,
            created_at: new Date().toISOString()
          };
        } else {
          // Несколько файлов — мульти-формат
          msgPayload = {
            channel_id: selectedChannel.id, sender_id: user.id,
            content: content || null,
            file_url: JSON.stringify(uploaded), file_name: null,
            file_type: 'multi', file_size: null,
            created_at: new Date().toISOString()
          };
        }
        const { data: newFileMsg } = await sb().from('channel_messages').insert(msgPayload).select('id').single();
        if (newFileMsg) await _forwardPostToCommentsGroup(newFileMsg.id, content, uploaded[0]?.name || null);
        if (window.Chat && window.Chat.clearSelectedFile) window.Chat.clearSelectedFile();
      } else {
        const chInsert = {
          channel_id: selectedChannel.id,
          sender_id: user.id,
          content,
          created_at: new Date().toISOString()
        };
        if (_channelReplyTo) {
          chInsert.reply_to = _channelReplyTo.msgId;
          chInsert.reply_text = (_channelReplyTo.quoteText || _channelReplyTo.text || '').slice(0, 100);
          chInsert.quote_text = _channelReplyTo.quoteText || null;
        }
        const { data: newMsg } = await sb().from('channel_messages').insert(chInsert).select('id').single();
        // Авто-дублирование в группу комментариев
        if (newMsg) await _forwardPostToCommentsGroup(newMsg.id, content, null);
      }

      _channelReplyTo = null;
      const replyBanner = document.getElementById('reply-banner');
      if (replyBanner) replyBanner.style.display = 'none';
      if (input) { input.value = ''; input.style.height = 'auto'; }
    } catch (e) {
      toast('Ошибка отправки', 'error');
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  // ============================================================
  // 5. СОЗДАНИЕ КАНАЛА
  // ============================================================
  function openCreateChannelModal() {
    _channelCreateType = 'public';
    const modal = getEl('create-channel-modal');
    if (modal) modal.style.display = 'flex';
    _setChannelType('public');
    const nameInput = getEl('channel-name-input');
    const descInput = getEl('channel-desc-input');
    if (nameInput) { nameInput.value = ''; nameInput.focus(); }
    if (descInput) descInput.value = '';
    // Закрываем бургер-меню
    if (window.Chat && window.Chat.closeMenu) window.Chat.closeMenu();
  }

  function closeCreateChannelModal() {
    const modal = getEl('create-channel-modal');
    if (modal) modal.style.display = 'none';
  }

  function _setChannelType(type) {
    _channelCreateType = type;
    const pub = getEl('ch-type-public');
    const priv = getEl('ch-type-private');
    if (pub) pub.classList.toggle('active', type === 'public');
    if (priv) priv.classList.toggle('active', type === 'private');
  }

  async function confirmCreateChannel() {
    const nameInput = getEl('channel-name-input');
    const descInput = getEl('channel-desc-input');
    const name = nameInput ? nameInput.value.trim() : '';
    const desc = descInput ? descInput.value.trim() : '';
    const isPublic = _channelCreateType === 'public';

    if (!name) { toast('Введите название канала', 'error'); return; }
    if (name.length < 2) { toast('Название слишком короткое', 'error'); return; }

    const btn = getEl('confirm-create-channel-btn');
    if (btn) btn.disabled = true;

    try {
      const { data: channelId, error } = await sb().rpc('create_channel', {
        p_name: name,
        p_is_public: isPublic,
        p_description: desc
      });
      if (error) throw error;

      toast(`Канал «${name}» создан!`, 'success');
      closeCreateChannelModal();
      await loadChannels();
      // Обновляем список в сайдбаре
      const container = getEl('conversations-list');
      if (container) renderChannelsInList(container);

      // Автоматически создаём группу для комментариев
      try {
        const groupId = await _createCommentsGroup(channelId);
        if (groupId) {
          _saveCommentsState(channelId, groupId, true);
        }
      } catch(e) { console.warn('[Channel] Auto-create comments group failed:', e); }

      // Открываем новый канал
      const newCh = channels.find(c => c.id === channelId);
      if (newCh) openChannelChat(newCh);

    } catch (e) {
      toast('Ошибка создания канала: ' + (e.message || ''), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ============================================================
  // 6. ВСТУПЛЕНИЕ В КАНАЛ
  // ============================================================
  // Вступить в публичный канал (кнопка снизу)
  async function joinPublicChannel(channelId) {
    const user = currentUser();
    if (!user) return;
    try {
      const { error } = await sb().rpc('join_public_channel', { p_channel_id: channelId });
      if (error) throw error;
      toast('Вы вступили в канал!', 'success');

      // Оптимистично загружаем данные канала сразу (до loadChannels)
      // чтобы канал появился немедленно, не зависит от скорости RPC
      if (!channels.find(c => c.id === channelId)) {
        try {
          const { data: chData } = await sb().from('channels').select('*').eq('id', channelId).single();
          if (chData) channels.push({ ...chData, my_role: 'member', muted: false, member_count: null });
        } catch {}
      }
      const container = getEl('conversations-list');
      if (container) renderChannelsInList(container);

      // Полная перезагрузка для синхронизации
      await loadChannels();
      if (container) renderChannelsInList(container);

      // Также обновляем через chat.js чтобы список диалогов полностью перерисовался
      if (window.Chat && window.Chat.reloadConversations) window.Chat.reloadConversations();

      const ch = channels.find(c => c.id === channelId);
      if (ch) openChannelChat(ch);
    } catch (e) {
      toast('Ошибка вступления: ' + (e.message || ''), 'error');
    }
  }

  // Обработка invite-ссылки при загрузке страницы
  function checkChannelInviteUrl() {
    const params = new URLSearchParams(window.location.search);
    const channelId = params.get('join_channel');
    if (channelId) {
      // Убираем параметр из URL без перезагрузки
      const url = new URL(window.location);
      url.searchParams.delete('join_channel');
      window.history.replaceState({}, '', url.toString());
      // Показываем окно вступления
      setTimeout(() => showChannelInviteJoinModal(channelId), 800);
    }
  }

  // Показать модальное окно вступления по ссылке
  async function showChannelInviteJoinModal(channelId) {
    pendingInviteChannelId = channelId;

    // Загрузить инфо о канале
    try {
      const { data: chArr } = await sb()
        .from('channels')
        .select('*')
        .eq('id', channelId)
        .limit(1);
      const ch = chArr && chArr[0];
      if (!ch) { toast('Канал не найден', 'error'); return; }
      pendingInviteChannel = ch;

      // Получить кол-во участников
      const { data: cnt } = await sb().rpc('get_channel_member_count', { p_channel_id: channelId });

      const modal = getEl('channel-invite-join-modal');
      const avatarEl = getEl('chij-avatar');
      const nameEl = getEl('chij-name');
      const metaEl = getEl('chij-meta');

      if (avatarEl) {
        avatarEl.innerHTML = ch.avatar_url
          ? `<img src="${escHTML(ch.avatar_url)}" alt="">`
          : '📢';
      }
      if (nameEl) nameEl.textContent = ch.name;
      if (metaEl) {
        const typeStr = ch.is_public ? 'Публичный канал' : '🔒 Приватный канал';
        metaEl.textContent = `${typeStr} · ${pluralMembers(cnt || 0)}`;
      }
      // Проверяем: уже в канале?
      const alreadyMember = channels.some(c => c.id === channelId);
      const joinBtn = getEl('chij-join-btn');
      if (alreadyMember) {
        if (joinBtn) {
          joinBtn.textContent = 'Перейти к каналу';
          joinBtn.onclick = () => {
            closeChannelInviteJoinModal();
            const existingCh = channels.find(c => c.id === channelId);
            if (existingCh) openChannelChat(existingCh);
          };
        }
      } else {
        if (joinBtn) {
          joinBtn.textContent = 'Вступить';
          joinBtn.onclick = () => confirmJoinChannelByInvite();
        }
      }
      if (modal) modal.style.display = 'flex';
    } catch (e) {
      toast('Не удалось загрузить канал', 'error');
    }
  }

  function closeChannelInviteJoinModal() {
    const modal = getEl('channel-invite-join-modal');
    if (modal) modal.style.display = 'none';
    pendingInviteChannelId = null;
    pendingInviteChannel = null;
  }

  async function confirmJoinChannelByInvite() {
    if (!pendingInviteChannelId) return;
    const user = currentUser();
    if (!user) { toast('Войдите в аккаунт', 'error'); return; }

    const btn = getEl('chij-join-btn');
    if (btn) btn.disabled = true;
    try {
      const { error } = await sb().rpc('join_channel_by_invite', { p_channel_id: pendingInviteChannelId });
      if (error) throw error;
      toast('Вы вступили в канал!', 'success');
      closeChannelInviteJoinModal();
      await loadChannels();
      const ch = channels.find(c => c.id === pendingInviteChannelId)
                   || pendingInviteChannel;
      const container = getEl('conversations-list');
      if (container) renderChannelsInList(container);
      if (ch) openChannelChat(ch);
    } catch (e) {
      toast('Ошибка: ' + (e.message || ''), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ============================================================
  // 7. INVITE КОД (ADMIN) — вставляет IFlashCHANNEL_<id> в поле ввода
  // ============================================================
  function generateChannelInviteLink(channelId) {
    const user = currentUser();
    if (!user) return;
    const inviteCode = 'IFlashCHANNEL_' + channelId;
    const input = document.getElementById('message-input');
    if (input) {
      input.value = inviteCode;
      input.dispatchEvent(new Event('input'));
      input.focus();
      toast('Ссылка-приглашение вставлена в поле ввода', 'success');
    } else {
      // Fallback: скопировать
      navigator.clipboard.writeText(inviteCode).then(() => {
        toast('Код приглашения скопирован!', 'success');
      }).catch(() => {
        prompt('Скопируйте код:', inviteCode);
      });
    }
  }

  // Обработка клика по инвайт-карточке канала (из сообщения)
  async function handleChannelInviteClick(channelId) {
    const user = currentUser();
    if (!user) { toast('Войдите в аккаунт', 'error'); return; }
    await showChannelInviteJoinModal(channelId);
  }

  // ============================================================
  // 8. MUTE / UNMUTE
  // ============================================================
  async function toggleChannelMute(channelId) {
    const ch = channels.find(c => c.id === channelId);
    if (!ch) return;
    const newMuted = !ch.muted;
    try {
      await sb().rpc('set_channel_muted', { p_channel_id: channelId, p_muted: newMuted });
      ch.muted = newMuted;
      toast(newMuted ? 'Уведомления отключены' : 'Уведомления включены', 'success');
      // Перерисовываем заголовок и нижнюю панель
      if (selectedChannel && selectedChannel.id === channelId) {
        selectedChannel = { ...selectedChannel, muted: newMuted };
        const user = currentUser();
        const isMember = true;
        const isAdmin = ch.my_role === 'admin';
        renderChannelHeader(selectedChannel, selectedChannel.member_count, isMember, isAdmin);
        renderChannelFooter(selectedChannel, isMember, isAdmin);
      }
      // Обновляем иконку в сайдбаре
      const container = getEl('conversations-list');
      if (container) renderChannelsInList(container);
    } catch (e) {
      toast('Ошибка: ' + (e.message || ''), 'error');
    }
  }

  // ============================================================
  // 9. ПАНЕЛЬ ИНФОРМАЦИИ О КАНАЛЕ
  // ============================================================
  function openChannelInfo() {
    const ch = selectedChannel;
    if (!ch) return;
    renderChannelInfoPanel(ch);
    const panel = getEl('channel-info-panel');
    const overlay = getEl('channel-info-overlay');
    if (panel) panel.classList.add('open');
    if (overlay) overlay.classList.add('visible');
  }

  function closeChannelInfo() {
    const panel = getEl('channel-info-panel');
    const overlay = getEl('channel-info-overlay');
    if (panel) panel.classList.remove('open');
    if (overlay) overlay.classList.remove('visible');
  }

  function renderChannelInfoPanel(ch) {
    const avatarEl = getEl('cip-channel-avatar');
    const nameEl = getEl('cip-channel-name');
    const descEl = getEl('cip-channel-desc');
    const metaEl = getEl('cip-channel-meta');
    const adminBtns = getEl('cip-admin-btns');

    const chData = channels.find(c => c.id === ch.id) || ch;
    const isAdmin = chData.my_role === 'admin';
    const memberCount = chData.member_count;

    if (avatarEl) {
      avatarEl.innerHTML = ch.avatar_url
        ? `<img src="${escHTML(ch.avatar_url)}" alt="">`
        : '📢';
    }
    if (nameEl) {
      const verBadge2 = (window.IFlashSub && window.IFlashSub.isVerifiedChannel(ch.id))
        ? window.IFlashSub.verifiedBadgeHTML() : '';
      nameEl.style.display = 'flex';
      nameEl.style.alignItems = 'center';
      nameEl.style.gap = '4px';
      nameEl.innerHTML = escHTML(ch.name) + verBadge2;
    }
    if (descEl) descEl.textContent = _cleanDescription(ch.description || '');

    if (metaEl) {
      metaEl.innerHTML = `
        <span class="cip-badge">${ch.is_public ? '📢 Публичный' : '🔒 Приватный'}</span>
        ${memberCount !== null && memberCount !== undefined ? `<span>${pluralMembers(memberCount)}</span>` : ''}
      `;
    }

    if (adminBtns) {
      if (isAdmin) {
        adminBtns.innerHTML = `
          <button class="cip-admin-btn" onclick="Channels.channelRenameModal()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Изменить название
          </button>
          <button class="cip-admin-btn" onclick="Channels.channelChangeAvatarStart()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            Изменить аватарку
          </button>
          <button class="cip-admin-btn" onclick="Channels.generateChannelInviteLink('${escHTML(ch.id)}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            Пригласительная ссылка
          </button>
          <button class="cip-admin-btn cip-admin-btn--danger" onclick="Channels.deleteChannel('${escHTML(ch.id)}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            Удалить канал
          </button>
        `;
      } else {
        adminBtns.innerHTML = `
          <button class="cip-admin-btn cip-admin-btn--danger" onclick="Channels.leaveChannel('${escHTML(ch.id)}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Отписаться от канала
          </button>
        `;
      }
    }

    // Секция комментариев — только для admin
    const cipComments = getEl('cip-comments-section');
    if (cipComments) {
      if (isAdmin) {
        const commData = _getCommentsData(ch.id);
        const hasGroup = !!(commData && commData.groupId);
        const isEnabled = hasGroup && commData.enabled;
        cipComments.style.display = '';

        if (!hasGroup) {
          // Группы нет — показываем только кнопку "Создать чат"
          cipComments.innerHTML = `
            <div class="channel-comments-toggle-row" style="border-top:1px solid var(--divider);margin-top:4px;">
              <div class="channel-comments-label">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Чат комментариев
              </div>
            </div>
            <button class="channel-comments-create-btn" onclick="Channels._toggleChannelCommentsEnabled('${escHTML(ch.id)}')">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
              Создать чат комментариев
            </button>
          `;
        } else {
          // Группа есть — показываем тумблер вкл/выкл
          cipComments.innerHTML = `
            <div class="channel-comments-toggle-row" style="border-top:1px solid var(--divider);margin-top:4px;">
              <div class="channel-comments-label">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Чат комментариев
              </div>
              <label class="comments-toggle-switch">
                <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="Channels._toggleChannelCommentsEnabled('${escHTML(ch.id)}')">
                <span class="comments-toggle-slider"></span>
              </label>
            </div>
            <div style="padding:0 16px 12px;font-size:12px;color:var(--text-muted);">
              ${isEnabled ? '✅ Кнопка «Комментарии» видна под каждым постом.' : '⏸ Комментарии скрыты.'}
            </div>
          `;
        }
      } else {
        cipComments.style.display = 'none';
      }
    }

    // Список участников — только для админов
    const membersSection = getEl('cip-members-section');
    const membersList = getEl('cip-members-list');
    if (membersSection && membersList) {
      if (isAdmin) {
        membersSection.style.display = '';
        membersList.innerHTML = '<div style="text-align:center;padding:8px;color:var(--text-muted);font-size:12px;">Загрузка...</div>';
        _loadChannelMembers(ch.id).then(members => {
          if (!members || !members.length) {
            membersList.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px;">Нет участников</div>';
            return;
          }
          membersList.innerHTML = members.map(m => {
            const name = m.display_name || m.username || '?';
            const avatarHTML = m.avatar_url
              ? `<img src="${escHTML(m.avatar_url)}" style="width:30px;height:30px;border-radius:50%;object-fit:cover;">`
              : `<div style="width:30px;height:30px;border-radius:50%;background:var(--accent-color);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;">${escHTML(name.charAt(0).toUpperCase())}</div>`;
            const roleBadge = m.role === 'admin' ? '<span class="cip-member-role">ADMIN</span>' : '';
            return `<div class="cip-member-row" onclick="Chat.showUserProfile('${m.user_id}')" style="cursor:pointer;">${avatarHTML}<span class="cip-member-name">${escHTML(name)}</span>${roleBadge}</div>`;
          }).join('');
        });
      } else {
        membersSection.style.display = 'none';
      }
    }
  }

  // Загрузка участников канала
  async function _loadChannelMembers(channelId) {
    try {
      const { data: memberRows } = await sb().from('channel_members')
        .select('user_id, role')
        .eq('channel_id', channelId);
      if (!memberRows || memberRows.length === 0) return [];

      const userIds = memberRows.map(m => m.user_id);
      const { data: profiles } = await sb().from('profiles')
        .select('id, username, display_name, avatar_url')
        .in('id', userIds);

      const profileMap = {};
      if (profiles) profiles.forEach(p => { profileMap[p.id] = p; });

      return memberRows.map(m => ({
        user_id: m.user_id,
        role: m.role,
        username: profileMap[m.user_id]?.username,
        display_name: profileMap[m.user_id]?.display_name,
        avatar_url: profileMap[m.user_id]?.avatar_url,
      }));
    } catch { return []; }
  }

  // ============================================================
  // 10. УПРАВЛЕНИЕ КАНАЛОМ (ADMIN)
  // ============================================================
  function channelRenameModal() {
    const ch = selectedChannel;
    if (!ch) return;

    const old = document.getElementById('channel-rename-modal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.id = 'channel-rename-modal';
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:380px;">
        <div class="modal-box-header">
          <h3>Переименовать канал</h3>
          <button class="modal-box-close" onclick="document.getElementById('channel-rename-modal').remove()">✕</button>
        </div>
        <div class="modal-box-body">
          <input type="text" id="channel-new-name" class="settings-input" value="${escHTML(ch.name)}" maxlength="60" placeholder="Название канала">
        </div>
        <div class="modal-box-footer">
          <button class="btn-cancel" onclick="document.getElementById('channel-rename-modal').remove()">Отмена</button>
          <button class="btn-primary-sm" onclick="Channels._confirmChannelRename()">Сохранить</button>
        </div>
      </div>`;
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    const inp = document.getElementById('channel-new-name');
    if (inp) { inp.focus(); inp.select(); }
  }

  async function _confirmChannelRename() {
    const ch = selectedChannel;
    if (!ch) return;
    const inp = document.getElementById('channel-new-name');
    const newName = inp ? inp.value.trim() : '';
    if (!newName) { toast('Введите название', 'error'); return; }

    try {
      await sb().from('channels').update({ name: newName }).eq('id', ch.id);
      toast('Название изменено', 'success');
      const idx = channels.findIndex(c => c.id === ch.id);
      if (idx !== -1) channels[idx].name = newName;
      selectedChannel = { ...selectedChannel, name: newName };
      document.getElementById('channel-rename-modal')?.remove();
      renderChannelInfoPanel(selectedChannel);
      const container = getEl('conversations-list');
      if (container) renderChannelsInList(container);
      // Обновить заголовок
      const isAdmin = channels.find(c => c.id === ch.id)?.my_role === 'admin';
      renderChannelHeader(selectedChannel, selectedChannel.member_count, true, isAdmin);
    } catch (e) {
      toast('Ошибка: ' + (e.message || ''), 'error');
    }
  }

  // Смена аватарки канала (admin) — с кроппером
  function channelChangeAvatarStart() {
    const ch = selectedChannel;
    if (!ch) return;

    let inp = document.getElementById('channel-avatar-file-input');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.id = 'channel-avatar-file-input';
      inp.accept = 'image/jpeg,image/png,image/gif,image/webp';
      inp.style.display = 'none';
      document.body.appendChild(inp);
    }
    inp.onchange = async (e) => {
      const file = e.target.files[0];
      inp.value = '';
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { toast('Файл слишком большой (максимум 5 МБ)', 'error'); return; }

      // Используем кроппер если доступен
      if (window.Chat && window.Chat.openAvatarCropper) {
        window.Chat.openAvatarCropper(file, (croppedBlob) => _uploadChannelAvatar(ch, croppedBlob));
        return;
      }
      // Fallback без кроппера
      _uploadChannelAvatar(ch, file);
    };
    inp.click();
  }

  async function _uploadChannelAvatar(ch, blob) {
    try {
      const user = currentUser();
      if (!user) return;
      const path = `channel_avatars/${ch.id}_${Date.now()}`;
      const { error: upErr } = await sb().storage
        .from('chat-files')
        .upload(path, blob, { upsert: true, contentType: blob.type || 'image/jpeg' });
      if (upErr) throw upErr;

      const { data: { publicUrl } } = sb().storage.from('chat-files').getPublicUrl(path);
      await sb().from('channels').update({ avatar_url: publicUrl }).eq('id', ch.id);

      const idx = channels.findIndex(c => c.id === ch.id);
      if (idx !== -1) channels[idx].avatar_url = publicUrl;
      selectedChannel = { ...selectedChannel, avatar_url: publicUrl };
      renderChannelInfoPanel(selectedChannel);
      const container = getEl('conversations-list');
      if (container) renderChannelsInList(container);
      renderChannelHeader(selectedChannel, selectedChannel.member_count, true, true);
      toast('Аватарка обновлена', 'success');
    } catch (er) {
      toast('Ошибка загрузки: ' + (er.message || ''), 'error');
    }
  }

  // Покинуть канал
  async function leaveChannel(channelId) {
    if (!confirm('Отписаться от канала?')) return;
    try {
      await sb().rpc('leave_channel', { p_channel_id: channelId });
      toast('Вы отписались от канала', 'info');
      channels = channels.filter(c => c.id !== channelId);
      if (selectedChannel && selectedChannel.id === channelId) {
        selectedChannel = null;
        // Показываем welcome screen
        const welcome = getEl('welcome-screen');
        const chatArea = getEl('chat-area');
        if (welcome) welcome.style.display = '';
        if (chatArea) chatArea.style.display = 'none';
        const old = document.getElementById('channel-footer-panel');
        if (old) old.remove();
        const inputArea = document.querySelector('.chat-input-area');
        if (inputArea) inputArea.style.display = '';
      }
      closeChannelInfo();
      const container = getEl('conversations-list');
      if (container) renderChannelsInList(container);
    } catch (e) {
      toast('Ошибка: ' + (e.message || ''), 'error');
    }
  }

  // Удалить канал (только создатель) — полный каскад
  async function deleteChannel(channelId) {
    if (!confirm('Удалить канал безвозвратно?\n\nБудут удалены все посты, комментарии, реакции и группа комментариев.')) return;
    try {
      // Try RPC cascade delete first (preferred — handles everything in one transaction)
      const { error: rpcErr } = await sb().rpc('delete_channel_cascade', { p_channel_id: channelId });
      if (rpcErr) {
        // Fallback: manual cascade
        // 1. Get comments group ID from channel description
        const ch = channels.find(c => c.id === channelId) || selectedChannel;
        const commGroupId = ch ? _parseCommentsGroupId(ch.description || '') : null;

        // 2. Delete reactions to channel posts
        await sb().from('channel_message_reactions').delete()
          .in('message_id',
            (await sb().from('channel_messages').select('id').eq('channel_id', channelId)).data?.map(r => r.id) || []
          ).then(() => {});

        // 3. Delete channel posts
        await sb().from('channel_messages').delete().eq('channel_id', channelId);

        // 4. Delete comments group data
        if (commGroupId) {
          await sb().from('group_messages').delete().eq('group_id', commGroupId);
          await sb().from('group_members').delete().eq('group_id', commGroupId);
          await sb().from('groups').delete().eq('id', commGroupId);
        }

        // 5. Delete channel members
        await sb().from('channel_members').delete().eq('channel_id', channelId);

        // 6. Delete the channel itself
        await sb().from('channels').delete().eq('id', channelId);
      }

      toast('Канал удалён', 'info');
      channels = channels.filter(c => c.id !== channelId);
      selectedChannel = null;
      closeChannelInfo();
      const welcome = getEl('welcome-screen');
      const chatArea = getEl('chat-area');
      if (welcome) welcome.style.display = '';
      if (chatArea) chatArea.style.display = 'none';
      const old = document.getElementById('channel-footer-panel');
      if (old) old.remove();
      const inputArea = document.querySelector('.chat-input-area');
      if (inputArea) inputArea.style.display = '';
      const container = getEl('conversations-list');
      if (container) renderChannelsInList(container);
    } catch (e) {
      toast('Ошибка удаления: ' + (e.message || ''), 'error');
    }
  }

  // ============================================================
  // 10b. РЕАКЦИИ НА СООБЩЕНИЯ КАНАЛА
  // ============================================================

  const CH_QUICK_EMOJIS = ['👍','❤️','😂','🔥','😮','😢','👎','🎉'];
  const CH_ALL_EMOJIS = [
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
    // Сердца и символы
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍',
    '🤎','💔','❤️‍🔥','❤️‍🩹','💕','💞','💓',
    '💗','💖','💘','💝','💟','☮️','🫶',
    // Предметы и символы
    '⭐','🌟','✨','💯','🔥','💎','🏆','🎉',
    '🎊','🎁','🎈','🎯','🚀','💡','📌','✅',
    '❌','⚡','💥','🍕','🍺','☕','🍿','🎵',
    '🎶','🌈','☀️','🌙','⛅','🌊','🍀','🌸'
  ];

  function _renderChReactions(msgId) {
    const bar = document.getElementById(`rcounts-${msgId}`);
    if (!bar) return;
    const reacts = chReactionsCache[msgId] || {};
    const user = currentUser();
    const uid = user?.id;
    const entries = Object.entries(reacts).filter(([, s]) => s.size > 0);
    if (!entries.length) { bar.innerHTML = ''; return; }
    bar.innerHTML = entries.map(([emoji, users]) => {
      const mine = uid && users.has(uid);
      return `<button class="reaction-count-chip${mine ? ' mine' : ''}" onclick="Channels._toggleChReaction('${msgId}','${emoji}')" title="${mine ? 'Убрать реакцию' : 'Добавить реакцию'}"><span class="reaction-emoji-display">${emoji}</span><span class="reaction-chip-count">${users.size}</span></button>`;
    }).join('');
  }

  function _buildChReactionBar(msgId) {
    return `
      <div class="reaction-bar" data-msg-id="${msgId}">
        <div class="reaction-counts" id="rcounts-${msgId}"></div>
        <div class="reaction-picker-wrap">
          <button class="reaction-quick-trigger" onclick="Channels.toggleChReactionPicker('${msgId}', event)" aria-label="Реакция">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
          </button>
          <div class="reaction-picker" id="rpicker-${msgId}" style="display:none;">
            <div class="reaction-picker-quick">
              ${CH_QUICK_EMOJIS.map(e => `<button class="reaction-emoji-btn" onclick="Channels._toggleChReaction('${msgId}','${e}')">${e}</button>`).join('')}
              <button class="reaction-expand-btn" onclick="Channels.toggleChReactionPickerExpand('${msgId}')" title="Все эмодзи">＋</button>
            </div>
            <div class="reaction-picker-full" id="rfull-${msgId}" style="display:none;">
              ${CH_ALL_EMOJIS.map(e => `<button class="reaction-emoji-btn" onclick="Channels._toggleChReaction('${msgId}','${e}')">${e}</button>`).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function toggleChReactionPicker(msgId, e) {
    e.stopPropagation();
    const picker = document.getElementById(`rpicker-${msgId}`);
    if (!picker) return;
    document.querySelectorAll('.reaction-picker').forEach((p) => {
      if (p.id !== `rpicker-${msgId}`) {
        p.style.display = 'none';
        const full = p.querySelector('.reaction-picker-full');
        if (full) full.style.display = 'none';
      }
    });
    if (picker.style.display !== 'none' && picker.style.display !== '') {
      picker.style.display = 'none';
      return;
    }
    const btn = e.currentTarget || e.target;
    const rect = btn.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.display = 'block';
    picker.style.left = '0';
    picker.style.top = '-9999px';
    requestAnimationFrame(() => {
      let x = rect.left;
      let y = rect.top - picker.offsetHeight - 6;
      if (x + picker.offsetWidth > window.innerWidth - 8) x = window.innerWidth - picker.offsetWidth - 8;
      if (x < 8) x = 8;
      if (y < 8) y = rect.bottom + 6;
      picker.style.left = x + 'px';
      picker.style.top = y + 'px';
    });
  }

  function toggleChReactionPickerExpand(msgId) {
    const full = document.getElementById(`rfull-${msgId}`);
    if (!full) return;
    full.style.display = full.style.display === 'none' ? 'grid' : 'none';
  }

  async function _toggleChReaction(msgId, emoji) {
    // Закрываем пикер
    const pickerEl = document.getElementById(`rpicker-${msgId}`);
    if (pickerEl) pickerEl.style.display = 'none';
    const user = currentUser();
    if (!user) return;
    if (!chReactionsCache[msgId]) chReactionsCache[msgId] = {};
    const set = chReactionsCache[msgId][emoji] || new Set();
    const hasMine = set.has(user.id);

    if (hasMine) {
      // Та же реакция — убираем (toggle off)
      set.delete(user.id);
      if (set.size === 0) delete chReactionsCache[msgId][emoji];
      else chReactionsCache[msgId][emoji] = set;
      _renderChReactions(msgId);
      await sb().from('channel_message_reactions')
        .delete().eq('message_id', msgId).eq('user_id', user.id).eq('emoji', emoji);
    } else {
      // Удаляем старую реакцию этого юзера (только 1 реакция на сообщение)
      for (const [oldEmoji, oldSet] of Object.entries(chReactionsCache[msgId])) {
        if (oldSet.has(user.id)) {
          oldSet.delete(user.id);
          if (oldSet.size === 0) delete chReactionsCache[msgId][oldEmoji];
        }
      }
      // Ставим новую
      const newSet = chReactionsCache[msgId][emoji] || new Set();
      newSet.add(user.id);
      chReactionsCache[msgId][emoji] = newSet;
      _renderChReactions(msgId);
      // В БД: удаляем все старые реакции юзера на это сообщение, вставляем новую
      await sb().from('channel_message_reactions')
        .delete().eq('message_id', msgId).eq('user_id', user.id);
      await sb().from('channel_message_reactions')
        .insert({ message_id: msgId, user_id: user.id, emoji });
    }
  }

  function _showChReactionPicker(msgId, clientX, clientY) {
    document.getElementById('ch-reaction-picker')?.remove();
    const picker = document.createElement('div');
    picker.id = 'ch-reaction-picker';
    picker.className = 'reaction-quick-bar';
    picker.innerHTML = CH_QUICK_EMOJIS.map(e =>
      `<button class="reaction-quick-btn" onclick="Channels._toggleChReaction('${msgId}','${e}');document.getElementById('ch-reaction-picker')?.remove();">${e}</button>`
    ).join('') + `<button class="reaction-quick-btn reaction-expand-ch" title="Все эмодзи" onclick="Channels._expandChReactionPicker('${msgId}')">＋</button>`;
    document.body.appendChild(picker);
    // Позиционирование
    picker.style.left = '0'; picker.style.top = '-9999px';
    requestAnimationFrame(() => {
      let x = clientX - picker.offsetWidth / 2;
      let y = clientY - picker.offsetHeight - 8;
      if (x + picker.offsetWidth > window.innerWidth - 8) x = window.innerWidth - picker.offsetWidth - 8;
      if (x < 8) x = 8;
      if (y < 8) y = clientY + 8;
      picker.style.left = x + 'px'; picker.style.top = y + 'px';
    });
    const close = (ev) => { if (!picker.contains(ev.target)) { picker.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 50);
  }

  function _expandChReactionPicker(msgId) {
    const picker = document.getElementById('ch-reaction-picker');
    if (!picker) return;
    // Заменяем содержимое на полную сетку эмодзи
    picker.innerHTML = `<div class="ch-emoji-grid">${CH_ALL_EMOJIS.map(e =>
      `<button class="reaction-quick-btn" onclick="Channels._toggleChReaction('${msgId}','${e}');document.getElementById('ch-reaction-picker')?.remove();">${e}</button>`
    ).join('')}</div>`;
    // Перепозиционируем — может понадобиться пересчёт
    requestAnimationFrame(() => {
      let x = parseFloat(picker.style.left);
      let y = parseFloat(picker.style.top);
      if (x + picker.offsetWidth > window.innerWidth - 8) x = window.innerWidth - picker.offsetWidth - 8;
      if (x < 8) x = 8;
      if (y + picker.offsetHeight > window.innerHeight - 8) y = window.innerHeight - picker.offsetHeight - 8;
      if (y < 8) y = 8;
      picker.style.left = x + 'px'; picker.style.top = y + 'px';
    });
  }

  async function _loadChReactionsForChannel(channelId) {
    chReactionsCache = {};
    try {
      // Получаем ID сообщений канала
      const { data: msgs } = await sb().from('channel_messages')
        .select('id').eq('channel_id', channelId);
      if (!msgs || !msgs.length) return;
      const msgIds = msgs.map(m => m.id);

      // Загружаем реакции для этих сообщений
      const { data } = await sb().from('channel_message_reactions')
        .select('message_id,emoji,user_id')
        .in('message_id', msgIds);

      (data || []).forEach(r => {
        if (!chReactionsCache[r.message_id]) chReactionsCache[r.message_id] = {};
        if (!chReactionsCache[r.message_id][r.emoji]) chReactionsCache[r.message_id][r.emoji] = new Set();
        chReactionsCache[r.message_id][r.emoji].add(r.user_id);
      });
    } catch {}
  }

  function _subscribeToChReactions(channelId) {
    sb().channel(`ch-reactions-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'channel_message_reactions' }, (payload) => {
        const msgId = payload.new?.message_id || payload.old?.message_id;
        if (!msgId) return;
        if (!chReactionsCache[msgId]) chReactionsCache[msgId] = {};

        if (payload.eventType === 'INSERT' && payload.new) {
          const { emoji, user_id } = payload.new;
          if (!chReactionsCache[msgId][emoji]) chReactionsCache[msgId][emoji] = new Set();
          chReactionsCache[msgId][emoji].add(user_id);
          _renderChReactions(msgId);
        } else if (payload.eventType === 'DELETE') {
          if (payload.old?.emoji && payload.old?.user_id) {
            const { emoji, user_id } = payload.old;
            if (chReactionsCache[msgId][emoji]) {
              chReactionsCache[msgId][emoji].delete(user_id);
              if (chReactionsCache[msgId][emoji].size === 0) delete chReactionsCache[msgId][emoji];
            }
            _renderChReactions(msgId);
          } else {
            // Без REPLICA IDENTITY FULL — перечитываем
            sb().from('channel_message_reactions').select('emoji,user_id').eq('message_id', msgId)
              .then(({ data }) => {
                chReactionsCache[msgId] = {};
                (data || []).forEach(r => {
                  if (!chReactionsCache[msgId][r.emoji]) chReactionsCache[msgId][r.emoji] = new Set();
                  chReactionsCache[msgId][r.emoji].add(r.user_id);
                });
                _renderChReactions(msgId);
              });
          }
        }
      })
      .subscribe();
  }

  // ============================================================
  // 10c. ОТЛОЖЕННАЯ ОТПРАВКА (SCHEDULED SEND)
  // ============================================================

  let _scheduledFile = null; // Файл для отложенного сообщения
  let _scheduledPickedTime = null; // Выбранное время

  function _getScheduledMessages(channelId) {
    try {
      return JSON.parse(localStorage.getItem(`ch_scheduled_${channelId}`) || '[]');
    } catch { return []; }
  }

  function _saveScheduledMessages(channelId, list) {
    localStorage.setItem(`ch_scheduled_${channelId}`, JSON.stringify(list));
  }

  function openScheduledSendModal(channelId) {
    document.getElementById('scheduled-send-modal')?.remove();
    _scheduledFile = null;
    _scheduledPickedTime = null;

    const now = new Date();
    // Варианты быстрого выбора времени
    function fmtOption(d) {
      return d.toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
    const opts = [
      { label: 'Через 1 час',   value: new Date(now.getTime() + 3600000) },
      { label: 'Через 3 часа',  value: new Date(now.getTime() + 10800000) },
      { label: 'Через 6 часов', value: new Date(now.getTime() + 21600000) },
      { label: 'Завтра в 9:00', value: (() => { const d = new Date(now); d.setDate(d.getDate()+1); d.setHours(9,0,0,0); return d; })() },
      { label: 'Послезавтра в 9:00', value: (() => { const d = new Date(now); d.setDate(d.getDate()+2); d.setHours(9,0,0,0); return d; })() },
    ];

    // Минимальное значение для datetime-local (сейчас + 2 мин)
    const minDt = new Date(now.getTime() + 120000);
    function toLocalISO(d) {
      const pad = n => String(n).padStart(2,'0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    const modal = document.createElement('div');
    modal.id = 'scheduled-send-modal';
    modal.className = 'scheduled-send-modal';
    modal.innerHTML = `
      <div class="scheduled-send-box">
        <div class="scheduled-send-header">
          <div class="scheduled-send-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Отложенная отправка
          </div>
          <button class="scheduled-send-close" onclick="Channels.closeScheduledSendModal()">✕</button>
        </div>

        <textarea id="sched-msg-text" class="scheduled-send-textarea" placeholder="Текст сообщения..."></textarea>

        <div class="scheduled-file-row">
          <button class="scheduled-file-btn" onclick="document.getElementById('sched-file-input').click()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            Прикрепить файл
          </button>
          <span id="sched-file-name" class="scheduled-file-name"></span>
          <input type="file" id="sched-file-input" class="visually-hidden" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.zip">
        </div>

        <div class="scheduled-time-label">Выберите время отправки</div>
        <div class="scheduled-quick-times" id="sched-quick-times">
          ${opts.map((o,i) => `<button class="scheduled-quick-btn" data-idx="${i}" onclick="Channels._pickScheduledTime(${o.value.getTime()}, this)">${o.label}<br><small style="font-size:10px;opacity:0.7;">${fmtOption(o.value)}</small></button>`).join('')}
        </div>

        <div class="scheduled-time-label" style="margin-top:4px;">Или введите своё время</div>
        <input type="datetime-local" id="sched-custom-dt" class="scheduled-custom-input"
          min="${toLocalISO(minDt)}" oninput="Channels._pickScheduledTimeCustom(this.value)">

        <div class="scheduled-send-actions">
          <button class="scheduled-cancel-btn" onclick="Channels.closeScheduledSendModal()">Отмена</button>
          <button class="scheduled-send-submit" onclick="Channels._submitScheduledMessage('${escHTML(channelId)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Запланировать
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Привязка файла
    const fileInput = modal.querySelector('#sched-file-input');
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) {
        _scheduledFile = fileInput.files[0];
        modal.querySelector('#sched-file-name').textContent = _scheduledFile.name;
      }
    });

    // Закрытие по клику на фон
    modal.addEventListener('click', (e) => { if (e.target === modal) closeScheduledSendModal(); });
  }

  function closeScheduledSendModal() {
    document.getElementById('scheduled-send-modal')?.remove();
    _scheduledFile = null;
    _scheduledPickedTime = null;
  }

  // ── Менеджер уже запланированных сообщений ──────────────────────────────
  function openScheduledMessagesManager(channelId) {
    document.getElementById('sched-manager-modal')?.remove();
    const list = _getScheduledMessages(channelId);
    const pending = list.filter(m => !m.sent);
    const sent    = list.filter(m => m.sent);

    function fmtTime(ts) {
      if (!ts) return '—';
      const d = new Date(ts);
      return d.toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    function renderItem(m) {
      const isPending = !m.sent;
      const timeLabel = isPending
        ? `<span class="sched-item-time pending">🕐 ${fmtTime(m.scheduleAt)}</span>`
        : `<span class="sched-item-time sent">✅ ${fmtTime(m.sentAt || m.scheduleAt)}</span>`;
      const fileHint = m.fileInfo
        ? `<span class="sched-item-file">📎 ${escHTML(m.fileInfo.name || 'Файл')}</span>`
        : '';
      const textPreview = m.content
        ? `<div class="sched-item-text">${escHTML(m.content.slice(0, 120))}${m.content.length > 120 ? '…' : ''}</div>`
        : `<div class="sched-item-text" style="opacity:0.45;font-style:italic;">Без текста</div>`;

      const actions = isPending ? `
        <div class="sched-item-actions">
          <button class="sched-item-btn sched-item-edit" onclick="Channels._editScheduledMsg('${escHTML(channelId)}','${escHTML(m.id)}')">✏️ Изменить</button>
          <button class="sched-item-btn sched-item-send-now" onclick="Channels._sendScheduledNow('${escHTML(channelId)}','${escHTML(m.id)}')">▶ Отправить сейчас</button>
          <button class="sched-item-btn sched-item-delete" onclick="Channels._deleteScheduledMsg('${escHTML(channelId)}','${escHTML(m.id)}')">🗑 Удалить</button>
        </div>` : '';

      return `
        <div class="sched-item ${isPending ? 'sched-item--pending' : 'sched-item--sent'}" data-id="${escHTML(m.id)}">
          <div class="sched-item-meta">${timeLabel}${fileHint}</div>
          ${textPreview}
          ${actions}
        </div>`;
    }

    const pendingHTML = pending.length
      ? pending.map(renderItem).join('')
      : `<div class="sched-empty">Нет запланированных сообщений</div>`;

    const sentHTML = sent.length
      ? `<details class="sched-sent-section"><summary>Отправленные (${sent.length})</summary>${sent.map(renderItem).join('')}</details>`
      : '';

    const modal = document.createElement('div');
    modal.id = 'sched-manager-modal';
    modal.className = 'scheduled-send-modal';
    modal.innerHTML = `
      <div class="scheduled-send-box sched-manager-box">
        <div class="scheduled-send-header">
          <div class="scheduled-send-title">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Запланированные сообщения
          </div>
          <button class="scheduled-send-close" onclick="document.getElementById('sched-manager-modal')?.remove()">✕</button>
        </div>
        <div class="sched-manager-list">${pendingHTML}${sentHTML}</div>
        <div class="sched-manager-footer">
          <button class="scheduled-cancel-btn" onclick="document.getElementById('sched-manager-modal')?.remove()">Закрыть</button>
          <button class="scheduled-send-submit" onclick="document.getElementById('sched-manager-modal')?.remove();Channels.openScheduledSendModal('${escHTML(channelId)}')">
            + Добавить
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  function _deleteScheduledMsg(channelId, msgId) {
    if (!confirm('Удалить это запланированное сообщение?')) return;
    let list = _getScheduledMessages(channelId).filter(m => m.id !== msgId);
    _saveScheduledMessages(channelId, list);
    // Обновляем менеджер
    openScheduledMessagesManager(channelId);
  }

  async function _sendScheduledNow(channelId, msgId) {
    const list = _getScheduledMessages(channelId);
    const msg = list.find(m => m.id === msgId);
    if (!msg || msg.sent) return;
    if (!confirm('Отправить это сообщение прямо сейчас?')) return;
    // Выполняем немедленную отправку
    await _executeScheduledMessage(msg);
    msg.sent = true;
    msg.sentAt = new Date().toISOString();
    _saveScheduledMessages(channelId, list);
    openScheduledMessagesManager(channelId);
  }

  function _editScheduledMsg(channelId, msgId) {
    const list = _getScheduledMessages(channelId);
    const msg = list.find(m => m.id === msgId);
    if (!msg || msg.sent) return;
    // Открываем модал создания, но предзаполняем поля
    document.getElementById('sched-manager-modal')?.remove();
    openScheduledSendModal(channelId);
    // Ждём рендер и заполняем
    setTimeout(() => {
      const ta = document.getElementById('sched-msg-text');
      if (ta) ta.value = msg.content || '';
      // Отмечаем время
      if (msg.scheduleAt) {
        _scheduledPickedTime = msg.scheduleAt;
        const pad = n => String(n).padStart(2,'0');
        const d = new Date(msg.scheduleAt);
        const isoLocal = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const customInput = document.getElementById('sched-custom-dt');
        if (customInput) customInput.value = isoLocal;
      }
      // Удаляем старую запись — после сохранения будет новая
      list.splice(list.findIndex(m => m.id === msgId), 1);
      _saveScheduledMessages(channelId, list);
    }, 80);
  }

  function _pickScheduledTime(ts, btn) {
    _scheduledPickedTime = ts;
    document.querySelectorAll('.scheduled-quick-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const customInput = document.getElementById('sched-custom-dt');
    if (customInput) customInput.value = '';
  }

  function _pickScheduledTimeCustom(val) {
    if (!val) { _scheduledPickedTime = null; return; }
    _scheduledPickedTime = new Date(val).getTime();
    document.querySelectorAll('.scheduled-quick-btn').forEach(b => b.classList.remove('active'));
  }

  async function _submitScheduledMessage(channelId) {
    const textEl = document.getElementById('sched-msg-text');
    const content = textEl ? textEl.value.trim() : '';
    if (!content && !_scheduledFile) { toast('Введите сообщение или прикрепите файл', 'error'); return; }
    if (!_scheduledPickedTime) { toast('Выберите время отправки', 'error'); return; }
    const now = Date.now();
    if (_scheduledPickedTime <= now + 60000) { toast('Время должно быть минимум через 1 минуту', 'error'); return; }

    const user = currentUser();
    if (!user) return;

    let fileInfo = null;
    if (_scheduledFile) {
      // Загружаем файл сразу в Storage
      try {
        const ext = _scheduledFile.name.split('.').pop();
        const filePath = `${user.id}/${Date.now()}_sched.${ext}`;
        const { error: upErr } = await sb().storage
          .from('chat-files').upload(filePath, _scheduledFile, { cacheControl: '3600', upsert: false });
        if (upErr) throw upErr;
        const { data: urlData } = sb().storage.from('chat-files').getPublicUrl(filePath);
        fileInfo = { url: urlData.publicUrl, name: _scheduledFile.name, type: _scheduledFile.type, size: _scheduledFile.size };
      } catch (e) {
        toast('Ошибка загрузки файла: ' + (e.message || ''), 'error');
        return;
      }
    }

    const list = _getScheduledMessages(channelId);
    list.push({
      id: Date.now() + '_' + Math.random().toString(36).slice(2),
      channelId,
      content,
      fileInfo,
      scheduleAt: _scheduledPickedTime,
      sent: false,
      createdAt: now
    });
    _saveScheduledMessages(channelId, list);

    const scheduledTs = _scheduledPickedTime; // сохраняем ДО закрытия (closeScheduledSendModal обнуляет переменную)
    closeScheduledSendModal();
    const dt = new Date(scheduledTs).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    toast(`Сообщение запланировано на ${dt}`, 'success');

    // Обновить счётчик в шапке
    const ch = selectedChannel;
    if (ch && ch.id === channelId) {
      const isAdmin = channels.find(c => c.id === channelId)?.my_role === 'admin';
      const isMember = channels.some(c => c.id === channelId);
      if (isAdmin) renderChannelHeader(ch, ch.member_count, isMember, isAdmin);
    }
  }

  // Проверка и отправка запланированных сообщений
  async function _sendDueScheduledMessages() {
    const user = currentUser();
    if (!user) return;
    const now = Date.now();

    // Ищем все ключи scheduled в localStorage
    const keys = Object.keys(localStorage).filter(k => k.startsWith('ch_scheduled_'));
    for (const key of keys) {
      const channelId = key.replace('ch_scheduled_', '');
      const list = _getScheduledMessages(channelId);
      let changed = false;
      for (const item of list) {
        if (item.sent || item.scheduleAt > now) continue;
        // Отправляем
        try {
          const msgData = {
            channel_id: channelId,
            sender_id: user.id,
            content: item.content || null,
            created_at: new Date().toISOString()
          };
          if (item.fileInfo) {
            msgData.file_url = item.fileInfo.url;
            msgData.file_name = item.fileInfo.name;
            msgData.file_type = item.fileInfo.type;
            msgData.file_size = item.fileInfo.size;
          }
          await sb().from('channel_messages').insert(msgData);
          item.sent = true;
          changed = true;
        } catch (e) {
          console.error('[Scheduled] send error:', e);
        }
      }
      if (changed) _saveScheduledMessages(channelId, list);
    }
  }

  // Отправить одно конкретное запланированное сообщение (используется и из менеджера)
  async function _executeScheduledMessage(item) {
    const user = window.Chat && window.Chat._currentUser;
    if (!user) return;
    const msgData = {
      channel_id: item.channelId,
      sender_id: user.id,
      content: item.content || null,
      created_at: new Date().toISOString()
    };
    if (item.fileInfo) {
      msgData.file_url = item.fileInfo.url;
      msgData.file_name = item.fileInfo.name;
      msgData.file_type = item.fileInfo.type;
      msgData.file_size = item.fileInfo.size;
    }
    await sb().from('channel_messages').insert(msgData);
  }

  function _startScheduledChecker() {
    // Проверяем сразу и каждые 10 секунд (меньше дрейф)
    _sendDueScheduledMessages();
    setInterval(_sendDueScheduledMessages, 10000);
  }

  // ============================================================
  // 10d. КОММЕНТАРИИ ПОД ПОСТАМИ КАНАЛА
  // ============================================================

  const CH_COMMENTS_MARKER = '|||ch_comments:';
  const CH_COMMENTS_END    = '|||';

  // Извлечь groupId из description канала
  function _parseCommentsGroupId(description) {
    if (!description) return null;
    const idx = description.indexOf(CH_COMMENTS_MARKER);
    if (idx === -1) return null;
    const start = idx + CH_COMMENTS_MARKER.length;
    const end = description.indexOf(CH_COMMENTS_END, start);
    if (end === -1) return null;
    return description.slice(start, end) || null;
  }

  // Получить описание без маркера
  function _cleanDescription(description) {
    if (!description) return '';
    const idx = description.indexOf(CH_COMMENTS_MARKER);
    if (idx === -1) return description;
    return description.slice(0, idx).trim();
  }

  // Получить статус комментариев (из description канала)
  function _getCommentsData(channelId) {
    const ch = channels.find(c => c.id === channelId) || selectedChannel;
    const rawDesc = ch?.description || '';
    const groupId = _parseCommentsGroupId(rawDesc);
    if (!groupId) return null;
    // Флаг enabled хранится локально (admin переключает вкл/выкл не удаляя группу)
    let enabled = true;
    try {
      const local = JSON.parse(localStorage.getItem(`ch_comments_state_${channelId}`) || 'null');
      if (local && local.groupId === groupId) enabled = local.enabled;
    } catch {}
    return { groupId, enabled };
  }

  function _saveCommentsState(channelId, groupId, enabled) {
    localStorage.setItem(`ch_comments_state_${channelId}`, JSON.stringify({ groupId, enabled }));
  }

  async function _createCommentsGroup(channelId) {
    const user = currentUser();
    if (!user) return null;
    const ch = channels.find(c => c.id === channelId) || selectedChannel;
    if (!ch) return null;
    try {
      const groupName = `💬 ${ch.name}`;
      const { data: groupId, error } = await sb().rpc('create_group', {
        p_name: groupName,
        p_member_ids: [user.id]
      });
      if (error) throw error;

      // Записываем groupId в description канала — видно всем через realtime
      const cleanDesc = _cleanDescription(ch.description || '');
      const newDesc = cleanDesc
        ? `${cleanDesc}${CH_COMMENTS_MARKER}${groupId}${CH_COMMENTS_END}`
        : `${CH_COMMENTS_MARKER}${groupId}${CH_COMMENTS_END}`;
      await sb().from('channels').update({ description: newDesc }).eq('id', channelId);

      // Обновляем локальный кэш
      const idx = channels.findIndex(c => c.id === channelId);
      if (idx !== -1) channels[idx] = { ...channels[idx], description: newDesc };
      if (selectedChannel && selectedChannel.id === channelId) {
        selectedChannel = { ...selectedChannel, description: newDesc };
      }
      return groupId;
    } catch (e) {
      toast('Ошибка создания чата: ' + (e.message || ''), 'error');
      return null;
    }
  }

  async function _toggleChannelCommentsEnabled(channelId) {
    const existing = _getCommentsData(channelId);
    if (!existing || !existing.groupId) {
      // Нет группы — создаём
      toast('Создание чата комментариев...', 'info');
      const groupId = await _createCommentsGroup(channelId);
      if (!groupId) return;
      _saveCommentsState(channelId, groupId, true);
      toast('Чат комментариев создан!', 'success');
    } else {
      // Переключаем вкл/выкл (не удаляем группу)
      const newState = !existing.enabled;
      _saveCommentsState(channelId, existing.groupId, newState);
      toast(newState ? 'Комментарии включены' : 'Комментарии отключены', 'success');
    }
    // Перерендеривать панель инфо
    const ch = channels.find(c => c.id === channelId) || selectedChannel;
    if (ch) renderChannelInfoPanel(ch);
    // Обновить футер
    const isMember = channels.some(c => c.id === channelId);
    const isAdmin = channels.find(c => c.id === channelId)?.my_role === 'admin';
    if (selectedChannel && selectedChannel.id === channelId) {
      renderChannelFooter(selectedChannel, isMember, isAdmin);
      // Обновляем видимость кнопок комментариев под постами
      const updatedCommData = _getCommentsData(channelId);
      const commEnabled = updatedCommData && updatedCommData.groupId && updatedCommData.enabled;
      document.querySelectorAll('.chmsg-comments-divider').forEach(el => el.style.display = commEnabled ? '' : 'none');
      document.querySelectorAll('.chmsg-post-actions').forEach(el => {
        if (commEnabled && !el.innerHTML.trim()) {
          const postId = el.id.replace('chmsg-pact-', '');
          el.innerHTML = `
            <button class="chmsg-comments-btn" data-post-id="${postId}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span>Комментарии</span>
              <span class="chmsg-cc" id="chmsg-cc-${postId}">0</span>
            </button>
          `;
          el.querySelector('.chmsg-comments-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            _openPostComments(postId, el.closest('.chmsg-wrapper'));
          });
        } else if (!commEnabled) {
          el.innerHTML = '';
        }
      });
    }
  }

  function _openCommentsGroup(channelId) {
    const data = _getCommentsData(channelId);
    if (!data || !data.groupId) { toast('Чат комментариев не найден', 'error'); return; }
    if (window.Chat && window.Chat._openGroupById) {
      window.Chat._openGroupById(data.groupId);
    }
  }

  // --- Авто-пересылка поста в группу комментариев ---
  async function _forwardPostToCommentsGroup(postId, content, fileName) {
    if (!selectedChannel) return;
    const commData = _getCommentsData(selectedChannel.id);
    if (!commData || !commData.groupId || !commData.enabled) return;
    const user = currentUser();
    if (!user) return;
    try {
      const preview = content ? content.slice(0, 120) : (fileName ? `📎 ${fileName}` : '');
      await sb().from('group_messages').insert({
        group_id: commData.groupId,
        sender_id: user.id,
        content: `📢POST_REF:${postId}📢\n${preview}`,
        created_at: new Date().toISOString()
      });
    } catch (e) { console.warn('[Comments] forward error:', e); }
  }

  // --- Обновить счётчик комментариев под постом ---
  async function _updateCommentCount(postId, groupId) {
    try {
      const { count } = await sb()
        .from('group_messages')
        .select('id', { count: 'exact', head: true })
        .eq('group_id', groupId)
        .like('content', `💬POST:${postId}💬%`);
      const el = document.getElementById(`chmsg-cc-${postId}`);
      if (el) el.textContent = count || 0;
    } catch {}
  }

  // --- Открыть диалог комментариев к посту ---
  let _commentsRealtimeSub = null;

  function _openPostComments(postId, wrapperEl) {
    const commData = selectedChannel ? _getCommentsData(selectedChannel.id) : null;
    if (!commData || !commData.groupId) { toast('Чат комментариев не настроен', 'error'); return; }

    // Проверяем подписку на канал
    const user = currentUser();
    if (user && selectedChannel) {
      const ch = channels.find(c => c.id === selectedChannel.id);
      if (!ch) {
        toast('Подпишитесь на канал, чтобы читать комментарии', 'error');
        return;
      }
    }

    // Текст оригинального поста
    const postTextEl = wrapperEl ? wrapperEl.querySelector('.chmsg-text') : null;
    const postBubble = wrapperEl ? wrapperEl.querySelector('.chmsg-card') : null;
    const postImgEl  = wrapperEl ? wrapperEl.querySelector('img[src]') : null;
    const postTime   = wrapperEl ? wrapperEl.querySelector('.chmsg-time')?.textContent : '';
    const channelName = selectedChannel?.name || 'Канал';

    let postPreviewHTML = '';
    if (postImgEl) postPreviewHTML += `<img src="${escHTML(postImgEl.src)}" style="max-width:100%;border-radius:8px;margin-bottom:4px;">`;
    if (postTextEl) postPreviewHTML += `<div style="font-size:14px;color:var(--text-primary);line-height:1.5;">${escHTML(postTextEl.textContent.slice(0, 200))}</div>`;
    if (!postPreviewHTML) postPreviewHTML = `<div style="font-size:13px;color:var(--text-muted);">📎 Медиа-сообщение</div>`;

    document.getElementById('post-comments-modal')?.remove();
    if (_commentsRealtimeSub) { try { sb().removeChannel(_commentsRealtimeSub); } catch {} _commentsRealtimeSub = null; }

    const modal = document.createElement('div');
    modal.id = 'post-comments-modal';
    modal.className = 'post-comments-modal';
    modal.innerHTML = `
      <div class="pcm-panel">
        <div class="pcm-header">
          <button class="pcm-close-btn" onclick="document.getElementById('post-comments-modal').remove()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
          <span class="pcm-title">Комментарии</span>
        </div>
        <div class="pcm-post-ref">
          <div class="pcm-post-channel">📢 ${escHTML(channelName)}</div>
          ${postPreviewHTML}
          ${postTime ? `<div class="pcm-post-time">${escHTML(postTime)}</div>` : ''}
        </div>
        <div class="pcm-divider"></div>
        <div class="pcm-messages-list" id="pcm-messages-list">
          <div class="pcm-loading">
            <div class="loading-spinner"></div>
          </div>
        </div>
        <div class="pcm-input-row" id="pcm-input-row">
          <div class="pcm-join-loading">
            <div class="loading-spinner" style="width:18px;height:18px;border-width:2px;"></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Проверяем членство в группе комментариев и рендерим нужный ввод
    _initCommentInputRow(commData.groupId, postId);

    // Авто-рост textarea инициализируется в _initCommentInputRow после проверки членства

    _loadPostComments(postId, commData.groupId);

    // Real-time для новых комментариев
    _commentsRealtimeSub = sb().channel(`pcm-${commData.groupId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_messages',
        filter: `group_id=eq.${commData.groupId}` }, (payload) => {
        if (!payload.new || !payload.new.content) return;
        if (!payload.new.content.startsWith(`💬POST:${postId}💬`)) return;
        _appendCommentToModal(payload.new);
        _updateCommentCount(postId, commData.groupId);
      })
      .subscribe();

    // Закрытие по клику вне панели
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
        if (_commentsRealtimeSub) { try { sb().removeChannel(_commentsRealtimeSub); } catch {} _commentsRealtimeSub = null; }
      }
    });
  }

  async function _loadPostComments(postId, groupId) {
    const listEl = document.getElementById('pcm-messages-list');
    if (!listEl) return;
    try {
      const { data } = await sb()
        .from('group_messages')
        .select('*')
        .eq('group_id', groupId)
        .like('content', `💬POST:${postId}💬%`)
        .order('created_at', { ascending: true });

      listEl.innerHTML = '';
      if (!data || !data.length) {
        listEl.innerHTML = '<div class="pcm-empty">Комментариев пока нет. Будьте первым!</div>';
        return;
      }
      for (const msg of data) _appendCommentToModal(msg);
      listEl.scrollTop = listEl.scrollHeight;
    } catch (e) {
      listEl.innerHTML = '<div class="pcm-empty">Ошибка загрузки. Возможно, нужно вступить в группу.</div>';
    }
  }

  function _appendCommentToModal(msg) {
    const listEl = document.getElementById('pcm-messages-list');
    if (!listEl) return;
    const stub = listEl.querySelector('.pcm-loading, .pcm-empty');
    if (stub) stub.remove();

    const user = currentUser();
    const text = msg.content ? msg.content.replace(/^💬POST:[^💬]*💬\n?/, '') : '';
    const allProfiles = (window.Chat && window.Chat._allProfiles) || [];
    const sender = allProfiles.find(p => p.id === msg.sender_id);
    const senderName = sender?.display_name || sender?.username || 'Пользователь';
    const isMine = user && msg.sender_id === user.id;
    const isAdmin = selectedChannel && (selectedChannel.my_role === 'admin' || selectedChannel.my_role === 'owner');

    const avatarEl = sender?.avatar_url
      ? `<img class="pcm-avatar" src="${escHTML(sender.avatar_url)}" alt="">`
      : `<div class="pcm-avatar pcm-avatar-letter">${escHTML((senderName[0] || '?').toUpperCase())}</div>`;

    // Защита от дублирования через realtime
    if (document.querySelector(`[data-comment-id="${msg.id}"]`)) return;

    const el = document.createElement('div');
    el.className = `pcm-comment${isMine ? ' pcm-comment-mine' : ''}`;
    el.dataset.commentId = msg.id;
    el.innerHTML = `
      ${!isMine ? avatarEl : ''}
      <div class="pcm-comment-body">
        ${!isMine ? `<div class="pcm-comment-sender">${escHTML(senderName)}</div>` : ''}
        <div class="pcm-comment-bubble">
          <div class="pcm-comment-text">${escHTML(text)}</div>
          <div class="pcm-comment-time">${fmtDate(msg.created_at)}</div>
        </div>
        ${_buildChReactionBar(msg.id)}
      </div>
    `;

    // Загружаем реакции на комментарий (добавляем в общий кеш)
    sb().from('channel_message_reactions')
      .select('message_id,emoji,user_id').eq('message_id', msg.id)
      .then(({ data }) => {
        if (!data) return;
        if (!chReactionsCache[msg.id]) chReactionsCache[msg.id] = {};
        data.forEach(r => {
          if (!chReactionsCache[msg.id][r.emoji]) chReactionsCache[msg.id][r.emoji] = new Set();
          chReactionsCache[msg.id][r.emoji].add(r.user_id);
        });
        _renderChReactions(msg.id);
      }).catch(() => {});

    // Контекстное меню по ПКМ
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      _showCommentContextMenu(e, msg, text, isMine, isAdmin);
    });

    listEl.appendChild(el);
    listEl.scrollTop = listEl.scrollHeight;
  }

  function _showCommentContextMenu(e, msg, text, isMine, isAdmin) {
    document.querySelectorAll('.pcm-ctx-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'pcm-ctx-menu msg-ctx-menu';
    menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:99999;`;

    const items = [];
    items.push({ label: 'Копировать', action: 'copy' });
    items.push({ label: 'Переслать', action: 'forward' });
    if (isMine) {
      items.push({ label: 'Удалить у себя', action: 'delete-self', cls: 'msg-ctx-item--danger' });
      items.push({ label: 'Удалить у всех', action: 'delete-all', cls: 'msg-ctx-item--danger' });
    } else if (isAdmin) {
      items.push({ label: 'Удалить у всех', action: 'delete-all', cls: 'msg-ctx-item--danger' });
    }

    menu.innerHTML = items.map(it =>
      `<button class="msg-ctx-item ${it.cls || ''}" data-action="${it.action}">${it.label}</button>`
    ).join('');

    document.body.appendChild(menu);

    // Корректируем позицию чтобы не выходило за экран
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = `${e.clientX - r.width}px`;
    if (r.bottom > window.innerHeight) menu.style.top = `${e.clientY - r.height}px`;

    menu.addEventListener('click', async (ev) => {
      const action = ev.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      menu.remove();
      if (action === 'copy') {
        navigator.clipboard.writeText(text).catch(() => {});
      } else if (action === 'forward') {
        window.Chat && window.Chat.openForwardModal && window.Chat.openForwardModal(msg.id, text);
      } else if (action === 'delete-self') {
        const commentEl = document.querySelector(`[data-comment-id="${msg.id}"]`);
        if (commentEl) commentEl.remove();
      } else if (action === 'delete-all') {
        try {
          let deleted = false;
          // Own message: delete directly (passes RLS sender check)
          if (isMine) {
            const { error } = await sb().from('group_messages').delete()
              .eq('id', msg.id).eq('sender_id', currentUser()?.id);
            deleted = !error;
          }
          // Admin deleting someone else's comment: use RPC with SECURITY DEFINER
          if (!deleted) {
            const { error: rpcErr } = await sb().rpc('admin_delete_comment', {
              p_msg_id: msg.id,
              p_channel_id: selectedChannel?.id || null
            });
            if (rpcErr) throw rpcErr;
          }
          const commentEl = document.querySelector(`[data-comment-id="${msg.id}"]`);
          if (commentEl) commentEl.remove();
        } catch (err) {
          toast('Ошибка удаления: ' + (err.message || ''), 'error');
        }
      }
    });

    const closeMenu = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', closeMenu, true); }
    };
    setTimeout(() => document.addEventListener('click', closeMenu, true), 50);
  }

  // Инициализирует строку ввода комментариев (проверяет членство в группе)
  async function _initCommentInputRow(groupId, postId) {
    const user = currentUser();
    const rowEl = document.getElementById('pcm-input-row');
    if (!rowEl) return;

    let isMember = false;
    if (user) {
      try {
        const { data } = await sb()
          .from('group_members')
          .select('user_id')
          .eq('group_id', groupId)
          .eq('user_id', user.id)
          .maybeSingle();
        isMember = !!data;
      } catch {}
    }

    if (isMember) {
      _renderCommentInputInRow(rowEl, groupId, postId);
    } else {
      rowEl.innerHTML = `
        <button class="pcm-join-btn" onclick="Channels._joinCommentGroup('${escHTML(groupId)}','${escHTML(postId)}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
          Вступить в группу комментариев
        </button>
      `;
    }
  }

  function _renderCommentInputInRow(rowEl, groupId, postId) {
    rowEl.innerHTML = `
      <textarea id="pcm-input" class="pcm-textarea" placeholder="Написать комментарий..." rows="1"></textarea>
      <button class="pcm-send-btn" onclick="Channels._sendPostComment('${escHTML(postId)}','${escHTML(groupId)}')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9l20-7z"/></svg>
      </button>
    `;
    const pcmInput = rowEl.querySelector('#pcm-input');
    if (pcmInput) {
      pcmInput.addEventListener('input', () => {
        pcmInput.style.height = 'auto';
        pcmInput.style.height = Math.min(pcmInput.scrollHeight, 100) + 'px';
      });
      pcmInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          Channels._sendPostComment(postId, groupId);
        }
      });
    }
  }

  async function _joinCommentGroup(groupId, postId) {
    const user = currentUser();
    if (!user) { toast('Войдите в систему', 'error'); return; }
    const btn = document.querySelector('.pcm-join-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Вступаем...'; }
    try {
      await sb().from('group_members').upsert(
        { group_id: groupId, user_id: user.id, role: 'member' },
        { onConflict: 'group_id,user_id', ignoreDuplicates: true }
      );
      const rowEl = document.getElementById('pcm-input-row');
      if (rowEl) _renderCommentInputInRow(rowEl, groupId, postId);
      toast('Вы вступили в группу комментариев!', 'success');
      setTimeout(() => document.getElementById('pcm-input')?.focus(), 100);
    } catch(e) {
      toast('Ошибка: ' + (e.message || ''), 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Вступить в группу комментариев'; }
    }
  }

  async function _sendPostComment(postId, groupId) {
    const user = currentUser();
    if (!user) return;

    // Проверяем, подписан ли пользователь на канал
    if (selectedChannel) {
      const ch = channels.find(c => c.id === selectedChannel.id);
      if (!ch) {
        toast('Подпишитесь на канал, чтобы оставлять комментарии', 'error');
        return;
      }
    }

    const input = document.getElementById('pcm-input');
    const text = input ? input.value.trim() : '';
    if (!text) return;

    const sendBtn = document.querySelector('.pcm-send-btn');
    if (sendBtn) sendBtn.disabled = true;

    try {
      // Добавляем пользователя в group_members (если ещё не там)
      // — нужно для обхода RLS на group_messages (комментарии хранятся как group_messages)
      await sb().from('group_members').upsert(
        { group_id: groupId, user_id: user.id, role: 'member' },
        { onConflict: 'group_id,user_id', ignoreDuplicates: true }
      );

      const { data: inserted } = await sb().from('group_messages').insert({
        group_id: groupId,
        sender_id: user.id,
        content: `💬POST:${postId}💬\n${text}`,
        created_at: new Date().toISOString()
      }).select().single();
      if (input) { input.value = ''; input.style.height = 'auto'; }
      // Сразу показываем свой комментарий, не дожидаясь realtime
      if (inserted) _appendCommentToModal(inserted);
      _updateCommentCount(postId, groupId);
    } catch (e) {
      toast('Ошибка: ' + (e.message || ''), 'error');
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  // ============================================================
  // 11. ПОИСК ПУБЛИЧНЫХ КАНАЛОВ
  // ============================================================
  async function searchPublicChannels(query) {
    if (!query || query.trim().length < 2) { searchChannelResults = []; return; }
    try {
      const { data, error } = await sb().rpc('search_public_channels', { p_query: query.trim() });
      searchChannelResults = (!error && data) ? data : [];
    } catch {
      searchChannelResults = [];
    }
  }

  function getSearchChannelResults() { return searchChannelResults; }

  // ============================================================
  // 12. REALTIME: обновления каналов
  // ============================================================
  function subscribeToChannelUpdates() {
    if (channelUpdatesSub) {
      try { sb().removeChannel(channelUpdatesSub); } catch {}
      channelUpdatesSub = null;
    }
    channelUpdatesSub = sb().channel('channels-updates-global')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'channels' }, (payload) => {
        if (!payload.new || !payload.new.id) return;
        const idx = channels.findIndex(c => c.id === payload.new.id);
        if (idx !== -1) {
          channels[idx] = { ...channels[idx], ...payload.new };
          if (selectedChannel && selectedChannel.id === payload.new.id) {
            selectedChannel = { ...selectedChannel, ...payload.new };
            renderChannelInfoPanel(selectedChannel);
          }
          const container = getEl('conversations-list');
          if (container) renderChannelsInList(container);
        }
      })
      .subscribe();
  }

  // ============================================================
  // 13. ОЧИСТКА ПРИ ВЫХОДЕ
  // ============================================================
  function cleanup() {
    if (channelRealtimeSub) {
      try { sb().removeChannel(channelRealtimeSub); } catch {}
      channelRealtimeSub = null;
    }
    if (channelUpdatesSub) {
      try { sb().removeChannel(channelUpdatesSub); } catch {}
      channelUpdatesSub = null;
    }
    channels = [];
    selectedChannel = null;
    channelMembersCache = {};
    searchChannelResults = [];
    pinnedMessages = [];
    const pinnedBar = document.getElementById('ch-pinned-bar');
    if (pinnedBar) pinnedBar.remove();
    const old = document.getElementById('channel-footer-panel');
    if (old) old.remove();
  }

  // ============================================================
  // 13b. ОПРОСЫ В КАНАЛАХ
  // ============================================================

  // Загрузить и отрисовать опросы канала (в начале messages-container)
  async function loadChannelPolls(channelId) {
    channelPolls = [];
    try {
      const { data: polls, error } = await sb()
        .from('channel_polls')
        .select('*')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: true });

      if (error || !polls || polls.length === 0) return;

      // Загрузить голоса для всех опросов
      const pollIds = polls.map(p => p.id);
      const { data: votes } = await sb()
        .from('channel_poll_votes')
        .select('*')
        .in('poll_id', pollIds);

      channelPolls = polls;

      // Рендерим опросы перед сообщениями
      const container = getEl('messages-container');
      if (!container) return;

      const user = currentUser();
      // Убираем пустой экран если есть
      const empty = container.querySelector('.no-messages');
      if (empty) empty.remove();

      // Удаляем старые карточки опросов (предотвращаем дублирование)
      container.querySelectorAll('.channel-poll-card').forEach(el => el.remove());

      // Загружаем реакции на опросы
      const { data: pollReacts } = await sb().from('channel_message_reactions')
        .select('message_id,emoji,user_id').in('message_id', pollIds);
      (pollReacts || []).forEach(r => {
        if (!chReactionsCache[r.message_id]) chReactionsCache[r.message_id] = {};
        if (!chReactionsCache[r.message_id][r.emoji]) chReactionsCache[r.message_id][r.emoji] = new Set();
        chReactionsCache[r.message_id][r.emoji].add(r.user_id);
      });

      // Вставляем карточки опросов в начало
      polls.forEach(poll => {
        const pollVotes = votes ? votes.filter(v => v.poll_id === poll.id) : [];
        const myVote = user ? pollVotes.find(v => v.user_id === user.id) : null;
        const ch = channels.find(c => c.id === channelId);
        const isAdmin = ch && ch.my_role === 'admin';
        const el = buildPollCard(poll, pollVotes, myVote, isAdmin);
        // Вставляем перед первым сообщением
        const firstMsg = container.querySelector('.chmsg-wrapper, .channel-date-divider');
        if (firstMsg) container.insertBefore(el, firstMsg);
        else container.appendChild(el);
        // Отрисовываем реакции после добавления в DOM
        _renderChReactions(poll.id);
      });
    } catch (e) {
      console.warn('[Polls] loadChannelPolls error:', e);
    }
  }

  function buildPollCard(poll, allVotes, myVote, isAdmin) {
    const options = Array.isArray(poll.options) ? poll.options : [];
    const totalVotes = allVotes.length;

    const optionsHTML = options.map((opt, idx) => {
      const count = allVotes.filter(v => v.option_index === idx).length;
      const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
      const isMine = myVote && myVote.option_index === idx;
      const voted = !!myVote;

      if (voted) {
        return `<div class="poll-option poll-option-result ${isMine ? 'poll-option-mine' : ''}">
          <div class="poll-option-bar" style="width:${pct}%"></div>
          <span class="poll-option-text">${escHTML(opt)}</span>
          <span class="poll-option-pct">${pct}%</span>
          ${isMine ? '<span class="poll-check">✓</span>' : ''}
        </div>`;
      } else {
        return `<div class="poll-option poll-option-clickable" onclick="Channels.voteOnPoll('${escHTML(poll.id)}',${idx})">
          <span class="poll-option-text">${escHTML(opt)}</span>
        </div>`;
      }
    }).join('');

    const votesWord = totalVotes === 1 ? 'голос' : (totalVotes >= 2 && totalVotes <= 4 ? 'голоса' : 'голосов');
    const pollEl = document.createElement('div');
    pollEl.className = 'channel-poll-card';
    pollEl.dataset.pollId = poll.id;
    if (!chReactionsCache[poll.id]) chReactionsCache[poll.id] = {};
    pollEl.innerHTML = `
      <div class="poll-header">
        <span class="poll-icon">📊</span>
        <span class="poll-title">Опрос</span>
      </div>
      <div class="poll-question">${escHTML(poll.question)}</div>
      <div class="poll-options">${optionsHTML}</div>
      <div class="poll-footer">${totalVotes} ${votesWord}</div>
      ${_buildChReactionBar(poll.id)}
    `;

    // ПКМ по опросу (только для admin): удалить
    if (isAdmin) {
      pollEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        document.querySelectorAll('.msg-context-menu').forEach(m => m.remove());
        const menu = document.createElement('div');
        menu.className = 'msg-context-menu';
        menu.innerHTML = `<button class="msg-ctx-item msg-ctx-item--danger" data-action="delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>
          Удалить опрос
        </button>`;
        document.body.appendChild(menu);
        let mx = e.clientX, my = e.clientY;
        menu.style.left = '0'; menu.style.top = '-9999px';
        requestAnimationFrame(() => {
          const mh = menu.offsetHeight, mw = menu.offsetWidth;
          if (mx + mw > window.innerWidth - 8) mx = window.innerWidth - mw - 8;
          if (my + mh > window.innerHeight - 8) my = my - mh - 8;
          menu.style.left = mx + 'px'; menu.style.top = my + 'px';
        });
        menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
          menu.remove();
          deletePoll(poll.id);
        });
        const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
        setTimeout(() => document.addEventListener('mousedown', close), 50);
      });
    }

    return pollEl;
  }

  async function voteOnPoll(pollId, optionIndex) {
    const user = currentUser();
    if (!user) { toast('Войдите в аккаунт', 'error'); return; }

    try {
      const { error } = await sb()
        .from('channel_poll_votes')
        .insert({ poll_id: pollId, user_id: user.id, option_index: optionIndex });
      if (error) {
        if (error.code === '23505') { toast('Вы уже проголосовали', 'info'); return; }
        throw error;
      }
      toast('Голос принят!', 'success');
      // Перезагрузить опросы
      if (selectedChannel) await loadChannelPolls(selectedChannel.id);
    } catch (e) {
      toast('Ошибка: ' + (e.message || ''), 'error');
    }
  }

  async function deletePoll(pollId) {
    if (!confirm('Удалить опрос?')) return;
    try {
      await sb().from('channel_polls').delete().eq('id', pollId);
      const el = document.querySelector(`[data-poll-id="${pollId}"]`);
      if (el) el.remove();
      channelPolls = channelPolls.filter(p => p.id !== pollId);
      toast('Опрос удалён', 'info');
    } catch (e) {
      toast('Ошибка удаления: ' + (e.message || ''), 'error');
    }
  }

  // Открыть модальное окно создания опроса
  function openCreatePollModal() {
    const modal = getEl('create-poll-modal');
    if (!modal) return;
    // Сбросить поля
    const qInput = getEl('poll-question-input');
    if (qInput) qInput.value = '';
    const optsList = getEl('poll-options-list');
    if (optsList) {
      optsList.innerHTML = `
        <div class="poll-opt-row"><input type="text" class="poll-opt-input" placeholder="Вариант 1" maxlength="120"><button class="poll-opt-remove-btn" onclick="Channels._removePollOption(this)" style="display:none">✕</button></div>
        <div class="poll-opt-row"><input type="text" class="poll-opt-input" placeholder="Вариант 2" maxlength="120"><button class="poll-opt-remove-btn" onclick="Channels._removePollOption(this)" style="display:none">✕</button></div>
      `;
    }
    modal.style.display = 'flex';
  }

  function closeCreatePollModal() {
    const modal = getEl('create-poll-modal');
    if (modal) modal.style.display = 'none';
  }

  function _addPollOption() {
    const optsList = getEl('poll-options-list');
    if (!optsList) return;
    const rows = optsList.querySelectorAll('.poll-opt-row');
    if (rows.length >= 10) { toast('Максимум 10 вариантов', 'info'); return; }
    const idx = rows.length + 1;
    const row = document.createElement('div');
    row.className = 'poll-opt-row';
    row.innerHTML = `<input type="text" class="poll-opt-input" placeholder="Вариант ${idx}" maxlength="120"><button class="poll-opt-remove-btn" onclick="Channels._removePollOption(this)">✕</button>`;
    optsList.appendChild(row);
    // Показать кнопки удаления у всех если больше 2
    _updatePollRemoveBtns();
  }

  function _removePollOption(btn) {
    const row = btn.closest('.poll-opt-row');
    if (row) row.remove();
    _updatePollRemoveBtns();
    // Обновить placeholder-ы
    const optsList = getEl('poll-options-list');
    if (optsList) {
      optsList.querySelectorAll('.poll-opt-input').forEach((inp, i) => {
        if (!inp.value) inp.placeholder = `Вариант ${i + 1}`;
      });
    }
  }

  function _updatePollRemoveBtns() {
    const optsList = getEl('poll-options-list');
    if (!optsList) return;
    const rows = optsList.querySelectorAll('.poll-opt-row');
    rows.forEach(row => {
      const btn = row.querySelector('.poll-opt-remove-btn');
      if (btn) btn.style.display = rows.length > 2 ? '' : 'none';
    });
  }

  async function confirmCreatePoll() {
    const user = currentUser();
    if (!user || !selectedChannel) return;

    const question = (getEl('poll-question-input')?.value || '').trim();
    if (!question) { toast('Введите вопрос', 'error'); return; }

    const optsList = getEl('poll-options-list');
    const options = optsList
      ? Array.from(optsList.querySelectorAll('.poll-opt-input'))
          .map(inp => inp.value.trim())
          .filter(v => v.length > 0)
      : [];

    if (options.length < 2) { toast('Минимум 2 варианта ответа', 'error'); return; }

    const btn = getEl('poll-confirm-btn');
    if (btn) btn.disabled = true;

    try {
      const { error } = await sb().from('channel_polls').insert({
        channel_id: selectedChannel.id,
        question,
        options: options,
        created_by: user.id
      });
      if (error) throw error;
      toast('Опрос создан!', 'success');
      closeCreatePollModal();
      await loadChannelPolls(selectedChannel.id);
    } catch (e) {
      toast('Ошибка: ' + (e.message || ''), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ============================================================
  // ЗАКРЕПЛЕНИЕ СООБЩЕНИЙ В КАНАЛЕ
  // ============================================================
  let pinnedMessages = []; // [{ msgId, text }]
  let pinnedCurrentIndex = -1; // текущий индекс при листании (с конца)

  function _getPinnedKey(channelId) { return `ch_pinned_${channelId}`; }

  function _loadPinnedMessages(channelId) {
    try {
      pinnedMessages = JSON.parse(localStorage.getItem(_getPinnedKey(channelId)) || '[]');
    } catch { pinnedMessages = []; }
    pinnedCurrentIndex = pinnedMessages.length ? pinnedMessages.length - 1 : -1;
  }

  function _savePinnedMessages(channelId) {
    localStorage.setItem(_getPinnedKey(channelId), JSON.stringify(pinnedMessages));
  }

  function _isPinned(msgId) {
    return pinnedMessages.some(p => p.msgId === msgId);
  }

  function _togglePin(msgId, text) {
    if (!selectedChannel) return;
    if (_isPinned(msgId)) {
      pinnedMessages = pinnedMessages.filter(p => p.msgId !== msgId);
      toast('Сообщение откреплено', 'info');
    } else {
      pinnedMessages.push({ msgId, text: (text || '').slice(0, 100) });
      toast('Сообщение закреплено', 'success');
    }
    pinnedCurrentIndex = pinnedMessages.length ? pinnedMessages.length - 1 : -1;
    _savePinnedMessages(selectedChannel.id);
    _renderPinnedBar();
  }

  // Telegram-style: одна полоска, показывает 1 пин, клик → скролл + показать следующий
  function _renderPinnedBar() {
    let bar = document.getElementById('ch-pinned-bar');
    if (!pinnedMessages.length) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ch-pinned-bar';
      bar.className = 'ch-pinned-bar';
      const container = getEl('messages-container');
      if (container) container.parentNode.insertBefore(bar, container);
    }
    if (pinnedCurrentIndex < 0 || pinnedCurrentIndex >= pinnedMessages.length) {
      pinnedCurrentIndex = pinnedMessages.length - 1;
    }
    const current = pinnedMessages[pinnedCurrentIndex];
    const total = pinnedMessages.length;
    const num = pinnedCurrentIndex + 1;
    bar.innerHTML = `
      <div class="ch-pinned-single" onclick="Channels._cyclePinnedMessage()">
        <div class="ch-pinned-counter">${num}/${total}</div>
        <div class="ch-pinned-body">
          <div class="ch-pinned-label">Закреплённое сообщение</div>
          <div class="ch-pinned-text">${escHTML(current.text || '...')}</div>
        </div>
        <button class="ch-pinned-list-btn" onclick="event.stopPropagation(); Channels._showPinnedList()" title="Все закреплённые">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
      </div>
    `;
  }

  // Клик по пинбару — скроллим к текущему, показываем следующий
  function _cyclePinnedMessage() {
    if (!pinnedMessages.length) return;
    const current = pinnedMessages[pinnedCurrentIndex];
    _scrollToMessage(current.msgId);
    // Переключаем на следующий (от новых к старым, потом заново)
    pinnedCurrentIndex--;
    if (pinnedCurrentIndex < 0) pinnedCurrentIndex = pinnedMessages.length - 1;
    _renderPinnedBar();
  }

  // Модалка со списком всех закреплённых
  function _showPinnedList() {
    const old = document.getElementById('ch-pinned-list-modal');
    if (old) old.remove();
    const modal = document.createElement('div');
    modal.id = 'ch-pinned-list-modal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'display:flex;z-index:9999;';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:400px;width:90%;max-height:70vh;overflow-y:auto;">
        <h3 style="margin:0 0 12px;font-size:16px;color:var(--text-primary);">Закреплённые сообщения (${pinnedMessages.length})</h3>
        <div class="ch-pinned-list-items">
          ${pinnedMessages.slice().reverse().map((p, i) => `
            <div class="ch-pinned-list-row" onclick="Channels._scrollToMessage('${escHTML(p.msgId)}'); document.getElementById('ch-pinned-list-modal').remove();">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 2h6l-1.5 5H12h-1.5L9 2z"/><path d="M5.5 12H18.5L17 7H7L5.5 12z"/></svg>
              <span class="ch-pinned-list-text">${escHTML(p.text || 'Закреплённое сообщение')}</span>
            </div>
          `).join('')}
        </div>
        <button class="modal-close-btn" onclick="this.closest('.modal-overlay').remove()" style="margin-top:12px;width:100%;padding:10px;border:none;border-radius:10px;background:var(--bg-glass);color:var(--text-primary);cursor:pointer;">Закрыть</button>
      </div>
    `;
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }

  function _scrollToMessage(msgId) {
    const el = document.querySelector(`.chmsg-wrapper[data-msg-id="${msgId}"]`);
    if (!el) { toast('Сообщение не найдено', 'info'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const card = el.querySelector('.chmsg-card');
    if (card) {
      card.classList.add('chmsg-highlight');
      setTimeout(() => card.classList.remove('chmsg-highlight'), 2000);
    }
  }

  // Переслать сообщение канала в личный чат
  function _showChannelForwardModal(msg, fromChannel) {
    // Убираем старое
    const old = document.getElementById('channel-forward-modal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.id = 'channel-forward-modal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'display:flex;z-index:9999;';

    // Формируем переслать-код
    const senderName = (window.Chat && window.Chat._allProfiles
      ? window.Chat._allProfiles.find(p => p.id === msg.sender_id)
      : null)?.display_name || 'Неизвестно';
    const chName = fromChannel ? fromChannel.name : 'Канал';
    const chAvatar = fromChannel?.avatar_url || '';
    const fwdContent = msg.content || (msg.file_url ? '[медиафайл]' : '');

    modal.innerHTML = `
      <div class="modal-box" style="max-width:340px;padding:0;overflow:hidden;">
        <div class="modal-header">
          <span>Переслать сообщение</span>
          <button class="modal-close-btn" onclick="document.getElementById('channel-forward-modal').remove()">✕</button>
        </div>
        <div class="modal-body">
          <div style="background:var(--bg-hover);border-radius:12px;padding:10px 12px;margin-bottom:14px;font-size:13px;color:var(--text-secondary);">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              ${chAvatar ? `<img src="${escHTML(chAvatar)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;">` : '<span>📢</span>'}
              <strong style="color:var(--text-primary)">${escHTML(chName)}</strong>
            </div>
            <div style="color:var(--text-muted);font-size:12px;margin-bottom:4px;">${escHTML(senderName)}</div>
            <div style="white-space:pre-wrap;overflow:hidden;max-height:60px;color:var(--text-secondary)">${escHTML(fwdContent.slice(0, 120))}</div>
          </div>
          <label class="modal-label">Переслать в чат</label>
          <div style="display:flex;flex-direction:column;gap:8px;max-height:200px;overflow-y:auto;" id="fwd-chat-list">
            <div style="text-align:center;padding:16px;color:var(--text-muted);font-size:13px;">Загрузка...</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // Заполним список чатов + каналы (где я админ)
    const listEl = modal.querySelector('#fwd-chat-list');
    const conversations = window.Chat && window.Chat._conversationsList ? window.Chat._conversationsList : [];
    const adminChannels = channels.filter(c => c.my_role === 'admin' && c.id !== (fromChannel?.id));

    const itemStyle = `display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;cursor:pointer;transition:background 0.15s;`;
    const itemHover = `onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background=''";`;

    let html = '';

    // Каналы (только если пользователь — admin)
    if (adminChannels.length > 0) {
      html += `<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;padding:2px 10px 4px;">Каналы</div>`;
      html += adminChannels.map(ch => {
        const chAv = ch.avatar_url
          ? `<img src="${escHTML(ch.avatar_url)}" style="width:36px;height:36px;border-radius:10px;object-fit:cover;">`
          : `<div style="width:36px;height:36px;border-radius:10px;background:var(--accent-color);display:flex;align-items:center;justify-content:center;font-size:18px;">📢</div>`;
        return `<div onclick="Channels._forwardToChannel('${escHTML(ch.id)}','${escHTML(fwdContent)}','${encodeURIComponent(chName)}','channel')" style="${itemStyle}" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background=''">
          ${chAv}<span style="font-size:13px;color:var(--text-primary)">${escHTML(ch.name)}</span>
        </div>`;
      }).join('');
    }

    // Личные чаты
    if (conversations.length > 0) {
      html += `<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;padding:6px 10px 4px;">Чаты</div>`;
      html += conversations.map(conv => {
        const p = conv.profile || {};
        const name = p.display_name || p.username || 'Пользователь';
        const avatar = p.avatar_url
          ? `<img src="${escHTML(p.avatar_url)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;">`
          : `<div style="width:36px;height:36px;border-radius:50%;background:var(--accent-color);display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:14px;">${escHTML(name.charAt(0).toUpperCase())}</div>`;
        return `<div onclick="Channels._forwardToUser('${escHTML(p.id)}','${escHTML(fwdContent)}','${encodeURIComponent(chName)}','${encodeURIComponent(chAvatar || '')}')" style="${itemStyle}" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background=''">${avatar}<span style="font-size:13px;color:var(--text-primary)">${escHTML(name)}</span></div>`;
      }).join('');
    }

    listEl.innerHTML = html || '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:13px;">Нет доступных чатов</div>';
  }

  async function _forwardToChannel(channelId, content, fromName, sourceType) {
    document.getElementById('channel-forward-modal')?.remove();
    const user = currentUser();
    if (!user || !channelId) return;
    const decoded = decodeURIComponent(fromName);
    let fwdLabel;
    if (sourceType === 'group') {
      fwdLabel = `↪ Переслано из группы «${decoded}»`;
    } else if (sourceType === 'channel') {
      fwdLabel = `↪ Переслано из канала «${decoded}»`;
    } else {
      fwdLabel = `↪ Переслано от ${decoded}`;
    }
    const fwdText = content ? `${fwdLabel}\n${content}` : fwdLabel;
    try {
      await sb().from('channel_messages').insert({
        channel_id: channelId,
        sender_id: user.id,
        content: fwdText,
      });
      toast('Сообщение переслано в канал', 'success');
    } catch (e) {
      toast('Ошибка пересылки: ' + (e.message || ''), 'error');
    }
  }

  async function _forwardToUser(userId, content, chName, chAvatar) {
    document.getElementById('channel-forward-modal')?.remove();
    const user = currentUser();
    if (!user || !userId) return;
    const decodedChName = decodeURIComponent(chName);
    // Формат пересылки с указанием источника
    const fwdText = `↪ Переслано из канала «${decodedChName}»\n${content}`;
    try {
      await sb().from('messages').insert({
        sender_id: user.id,
        receiver_id: userId,
        content: fwdText
      });
      toast('Сообщение переслано', 'success');
    } catch (e) {
      toast('Ошибка пересылки: ' + (e.message || ''), 'error');
    }
  }

  // ============================================================
  // 14. ИНТЕГРАЦИЯ С CHAT.JS — HOOK
  // ============================================================
  // Этот объект используется chat.js для вызова наших функций
  window.Channels = {
    // Lifecycle
    loadChannels,
    _loadChannelUnreadCounts,
    cleanup,
    renderChannelsInList,
    subscribeToChannelUpdates,
    checkChannelInviteUrl,

    // Открытие
    openChannelChat,
    openChannelInfo,
    closeChannelInfo,

    // Создание
    openCreateChannelModal,
    closeCreateChannelModal,
    _setChannelType,
    confirmCreateChannel,

    // Вступление
    joinPublicChannel,
    showChannelInviteJoinModal,
    closeChannelInviteJoinModal,
    confirmJoinChannelByInvite,

    // Invite
    generateChannelInviteLink,
    handleChannelInviteClick,

    // Mute
    toggleChannelMute,

    // Управление
    channelRenameModal,
    _confirmChannelRename,
    channelChangeAvatarStart,
    leaveChannel,
    deleteChannel,
    deleteChannelMessage,

    // Опросы
    loadChannelPolls,
    openCreatePollModal,
    closeCreatePollModal,
    _addPollOption,
    _removePollOption,
    confirmCreatePoll,
    voteOnPoll,
    deletePoll,

    // Поиск
    searchPublicChannels,
    getSearchChannelResults,

    // Отправка сообщений
    sendChannelMessage,

    // Реакции в каналах
    _toggleChReaction,
    toggleChReactionPicker,
    toggleChReactionPickerExpand,
    _expandChReactionPicker,

    // Пересылка сообщений
    _forwardToUser,
    _forwardToChannel,

    // Закрепление
    _togglePin,
    _scrollToMessage,
    _cyclePinnedMessage,
    _showPinnedList,

    // 3-точки меню
    _openChannelMoreMenu,

    // Отложенная отправка
    openScheduledSendModal,
    closeScheduledSendModal,
    _pickScheduledTime,
    _pickScheduledTimeCustom,
    _submitScheduledMessage,
    // Менеджер запланированных сообщений
    openScheduledMessagesManager,
    _deleteScheduledMsg,
    _sendScheduledNow,
    _editScheduledMsg,

    // Комментарии под постами
    _toggleChannelCommentsEnabled,
    _openCommentsGroup,
    _openPostComments,
    _sendPostComment,
    _joinCommentGroup,
    _initCommentInputRow,
    _updateCommentCount,

    // Геттеры для интеграции
    get channels() { return channels; },
    get selectedChannel() { return selectedChannel; },
    set selectedChannel(v) { selectedChannel = v; },
    clearSelectedChannel() { selectedChannel = null; },
    get _channelReplyTo() { return _channelReplyTo; },
    set _channelReplyTo(v) { _channelReplyTo = v; }
  };

  // ============================================================
  // 15. ЗАПУСК: проверяем invite URL при старте
  // ============================================================
  document.addEventListener('DOMContentLoaded', () => {
    // Небольшая задержка — ждём инициализации Supabase
    setTimeout(checkChannelInviteUrl, 1500);
    // Запускаем проверку отложенных сообщений (через 5 сек после загрузки)
    setTimeout(_startScheduledChecker, 5000);
  });

})();
