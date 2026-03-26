// ============================================================
// subscriptions.js — Подписки IFlash + verified badge
// Подключается после channels.js в index.html
// ============================================================

(function () {
  // ---- Верифицированные каналы (hardcoded список) ----
  const VERIFIED_CHANNEL_IDS = new Set([
    '2e38ed6a-8813-4f6b-9ba4-5eccd76778dd',
    '2b12c833-cb47-4a2e-bc56-6096e76d57b6'
  ]);

  // ---- Верифицированные группы ----
  const VERIFIED_GROUP_IDS = new Set([
    '15941580-655f-4d9c-9c5a-1a89bb9c15f5'
  ]);

  // ---- Текущий план пользователя ----
  let myPlan = 'none'; // 'none' | 'plus' | 'pro'

  const sb = () => window.supabaseClient;

  // ============================================================
  // 1. ЗАГРУЗКА ПОДПИСКИ
  // ============================================================
  async function loadMySubscription() {
    try {
      const { data, error } = await sb().rpc('get_my_subscription');
      if (!error && data) {
        myPlan = data;
      } else {
        // Fallback: прямой запрос если RPC нет
        const user = window.Chat?._currentUser;
        if (user) {
          const { data: row } = await sb()
            .from('user_subscriptions')
            .select('plan, expires_at')
            .eq('user_id', user.id)
            .maybeSingle();
          if (row) {
            const expired = row.expires_at && new Date(row.expires_at) < new Date();
            myPlan = expired ? 'none' : (row.plan || 'none');
          }
        }
      }
    } catch (e) {
      console.warn('[Sub] loadMySubscription error:', e);
      myPlan = 'none';
    }
    applySubscriptionEffects();
  }

  // ============================================================
  // 2. ПРИМЕНЕНИЕ ЭФФЕКТОВ ПОДПИСКИ
  // ============================================================
  function applySubscriptionEffects() {
    // Анимация заголовков IFlash
    const appTitle  = document.querySelector('.app-title');
    const authTitle = document.querySelector('.auth-logo h1');

    [appTitle, authTitle].forEach(el => {
      if (!el) return;
      el.classList.remove('iflash-plus', 'iflash-pro');
      // Сбрасываем inline стили чтобы сработал CSS
      el.style.removeProperty('-webkit-text-fill-color');
      el.style.removeProperty('background');
      if (myPlan === 'pro') {
        el.classList.add('iflash-pro');
      } else if (myPlan === 'plus') {
        el.classList.add('iflash-plus');
      }
      // 'none' — просто цвет темы (CSS переменная --text-primary)
    });

    // Обновить страницу подписки если открыта
    renderSubscriptionPage();
    updateBurgerSubLabel();
  }

  // ============================================================
  // 3. БЕЙДЖ В HTML
  // ============================================================
  function planBadgeHTML(plan) {
    if (plan === 'pro') {
      return `<span class="sub-badge-pro">⚡ PRO</span>`;
    }
    if (plan === 'plus') {
      return `<span class="sub-badge-plus">⭐ Plus</span>`;
    }
    return '';
  }

  // Верифицированный бейдж канала (вращающийся синий кружок с галочкой)
  function verifiedBadgeHTML() {
    return `<span class="channel-verified-badge" title="Верифицированный канал">
      <svg viewBox="0 0 24 24" fill="none">
        <circle class="channel-verified-ring" cx="12" cy="12" r="10"
          stroke="url(#vgrad)" stroke-width="2.5" stroke-dasharray="5 2"
          stroke-linecap="round"/>
        <defs>
          <linearGradient id="vgrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#3b82f6"/>
            <stop offset="100%" stop-color="#06b6d4"/>
          </linearGradient>
        </defs>
        <path d="M7.5 12l3 3 5-6" stroke="#3b82f6" stroke-width="2.2"
          stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>`;
  }

  function isVerifiedChannel(channelId) {
    return VERIFIED_CHANNEL_IDS.has(channelId);
  }

  function isVerifiedGroup(groupId) {
    return VERIFIED_GROUP_IDS.has(groupId);
  }

  // ============================================================
  // 4. ОБНОВЛЕНИЕ СТРАНИЦЫ ПОДПИСОК
  // ============================================================
  function renderSubscriptionPage() {
    const statusBadge = document.getElementById('sub-status-badge');
    const btnPlus     = document.getElementById('sub-btn-plus');
    const btnPro      = document.getElementById('sub-btn-pro');

    if (statusBadge) {
      statusBadge.className = 'sub-status-badge';
      if (myPlan === 'pro') {
        statusBadge.classList.add('plan-pro');
        statusBadge.innerHTML = `⚡ У вас активен <b>IFlash PRO</b>`;
      } else if (myPlan === 'plus') {
        statusBadge.classList.add('plan-plus');
        statusBadge.innerHTML = `⭐ У вас активен <b>IFlash Plus</b>`;
      } else {
        statusBadge.textContent = 'Нет активной подписки';
      }
    }

    if (btnPlus) {
      if (myPlan === 'plus') {
        btnPlus.className = 'sub-btn sub-btn-active';
        btnPlus.innerHTML = '✓ Активна';
        btnPlus.disabled = true;
      } else if (myPlan === 'pro') {
        // PRO включает всё из Plus — показываем что уже есть
        btnPlus.className = 'sub-btn sub-btn-active';
        btnPlus.innerHTML = '✓ Включено в PRO';
        btnPlus.disabled = true;
      } else {
        btnPlus.className = 'sub-btn sub-btn-plus';
        btnPlus.innerHTML = 'Подключить Plus';
        btnPlus.disabled = false;
      }
    }

    if (btnPro) {
      if (myPlan === 'pro') {
        btnPro.className = 'sub-btn sub-btn-active';
        btnPro.innerHTML = '✓ Активна';
        btnPro.disabled = true;
      } else {
        btnPro.className = 'sub-btn sub-btn-pro';
        btnPro.innerHTML = 'Подключить PRO';
        btnPro.disabled = false;
      }
    }
  }

  // ============================================================
  // 5. ОБНОВЛЕНИЕ КНОПКИ В БУРГЕР-МЕНЮ
  // ============================================================
  function updateBurgerSubLabel() {
    const icon  = document.getElementById('burger-sub-icon');
    const label = document.getElementById('burger-sub-label');
    if (!icon || !label) return;

    if (myPlan === 'pro') {
      icon.textContent = '⚡';
      label.textContent = 'IFlash PRO — Активен';
    } else if (myPlan === 'plus') {
      icon.textContent = '⭐';
      label.textContent = 'IFlash Plus — Активен';
    } else {
      icon.textContent = '🚀';
      label.textContent = 'Подписка IFlash';
    }
  }

  // ============================================================
  // 6. ОТКРЫТИЕ ОПЛАТЫ (заглушка)
  // ============================================================
  function openPayment(plan) {
    if (window.Chat && window.Chat.showToast) {
      window.Chat.showToast('Оплата в разработке — обратитесь к администратору', 'info');
    }
  }

  // ============================================================
  // 7. ПУБЛИЧНЫЙ API
  // ============================================================
  window.IFlashSub = {
    loadMySubscription,
    applySubscriptionEffects,
    planBadgeHTML,
    verifiedBadgeHTML,
    isVerifiedChannel,
    isVerifiedGroup,
    openPayment,
    get myPlan() { return myPlan; }
  };

  // ============================================================
  // 8. ИНИЦИАЛИЗАЦИЯ
  // ============================================================
  // Применяем эффекты сразу при загрузке (план = 'none' по умолчанию)
  document.addEventListener('DOMContentLoaded', () => {
    applySubscriptionEffects();
  });

})();
