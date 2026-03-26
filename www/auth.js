// ============================================================
// auth.js — Логика входа, регистрации и валидации
// ============================================================

const Auth = (() => {
  // ---- Состояние ----
  let usernameCheckTimer = null;
  let currentView = 'login'; // 'login' | 'register'

  // ---- DOM Элементы ----
  const getEl = (id) => document.getElementById(id);

  // ---- Переключение вкладок ----
  function switchTab(tab) {
    currentView = tab;
    const loginTab = getEl('tab-login');
    const registerTab = getEl('tab-register');
    const loginForm = getEl('login-form');
    const registerForm = getEl('register-form');
    const authError = getEl('auth-error');

    authError.textContent = '';
    authError.classList.remove('visible');

    if (tab === 'login') {
      loginTab.classList.add('active');
      registerTab.classList.remove('active');
      registerForm.classList.remove('active');
      // Сброс классов анимации + reflow для перезапуска
      loginForm.classList.remove('slide-from-right', 'slide-from-left');
      void loginForm.offsetWidth;
      loginForm.classList.add('active', 'slide-from-left');
    } else {
      registerTab.classList.add('active');
      loginTab.classList.remove('active');
      loginForm.classList.remove('active');
      // Сброс классов анимации + reflow для перезапуска
      registerForm.classList.remove('slide-from-right', 'slide-from-left');
      void registerForm.offsetWidth;
      registerForm.classList.add('active', 'slide-from-right');
    }
  }

  // ---- Показ ошибки ----
  function showError(message) {
    const authError = getEl('auth-error');
    authError.textContent = message;
    authError.classList.add('visible');
  }

  // ---- Показ/скрытие загрузки на кнопке ----
  function setButtonLoading(btn, isLoading, defaultText) {
    btn.disabled = isLoading;
    if (isLoading) {
      btn.innerHTML = '<span class="btn-spinner"></span>';
    } else {
      btn.textContent = defaultText;
    }
  }

  // ---- Индикатор сложности пароля ----
  function getPasswordStrength(password) {
    let score = 0;
    if (!password) return { score: 0, label: '', color: '' };

    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;

    if (score <= 2) return { score, label: 'Слабый', color: 'var(--strength-weak)' };
    if (score <= 4) return { score, label: 'Средний', color: 'var(--strength-medium)' };
    return { score, label: 'Надёжный', color: 'var(--strength-strong)' };
  }

  function updatePasswordStrength(password) {
    const bar = getEl('strength-bar');
    const label = getEl('strength-label');
    if (!bar || !label) return;

    const { score, label: text, color } = getPasswordStrength(password);
    const percent = Math.min((score / 6) * 100, 100);

    bar.style.width = password ? percent + '%' : '0%';
    bar.style.backgroundColor = color;
    label.textContent = password ? text : '';
    label.style.color = color;
  }

  // ---- Живая проверка Username ----
  async function checkUsernameAvailability(username) {
    const statusEl = getEl('username-status');
    if (!statusEl) return;

    if (!username || username.length < 3) {
      statusEl.textContent = username.length > 0 ? 'Минимум 3 символа' : '';
      statusEl.className = 'field-status';
      return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      statusEl.textContent = 'Только буквы, цифры и _';
      statusEl.className = 'field-status status-error';
      return;
    }

    statusEl.textContent = 'Проверяем...';
    statusEl.className = 'field-status status-checking';

    try {
      const { data, error } = await window.supabaseClient
        .from('profiles')
        .select('id')
        .eq('username', username.toLowerCase())
        .maybeSingle();

      if (error) {
        statusEl.textContent = 'Ошибка проверки';
        statusEl.className = 'field-status status-error';
        return;
      }

      if (data) {
        statusEl.textContent = '✗ Имя занято';
        statusEl.className = 'field-status status-error';
      } else {
        statusEl.textContent = '✓ Доступно';
        statusEl.className = 'field-status status-success';
      }
    } catch (err) {
      statusEl.textContent = 'Ошибка сети';
      statusEl.className = 'field-status status-error';
    }
  }

  // ---- Живая проверка инвайт-кода ----
  let inviteCheckTimer = null;
  async function checkInviteCode(code) {
    const statusEl = getEl('invite-status');
    if (!statusEl) return;

    if (!code) {
      statusEl.textContent = '';
      statusEl.className = 'field-status';
      return;
    }

    // Формат IFlash_xxxxxxxxxxxxxxxx
    if (!/^IFlash_[a-zA-Z0-9]{16}$/.test(code)) {
      statusEl.textContent = 'Неверный формат кода';
      statusEl.className = 'field-status status-error';
      return;
    }

    statusEl.textContent = 'Проверяем...';
    statusEl.className = 'field-status status-checking';

    try {
      const { data, error } = await window.supabaseClient
        .rpc('check_invite_code', { p_code: code });

      if (error) {
        statusEl.textContent = 'Ошибка проверки';
        statusEl.className = 'field-status status-error';
        return;
      }

      if (data === true) {
        statusEl.textContent = '✓ Код действителен';
        statusEl.className = 'field-status status-success';
      } else {
        statusEl.textContent = '✗ Код недействителен или уже использован';
        statusEl.className = 'field-status status-error';
      }
    } catch (err) {
      statusEl.textContent = 'Ошибка сети';
      statusEl.className = 'field-status status-error';
    }
  }

  // ---- Регистрация ----
  async function handleRegister(e) {
    e.preventDefault();

    const email = getEl('reg-email').value.trim();
    const username = getEl('reg-username').value.trim().toLowerCase();
    const password = getEl('reg-password').value;
    const confirmPassword = getEl('reg-confirm-password').value;
    const inviteCode = getEl('reg-invite') ? getEl('reg-invite').value.trim() : '';
    const btn = getEl('register-btn');

    // Валидация
    if (!email || !username || !password || !confirmPassword || !inviteCode) {
      showError('Пожалуйста, заполните все поля.');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showError('Введите корректный email.');
      return;
    }

    if (username.length < 3) {
      showError('Имя пользователя должно быть не менее 3 символов.');
      return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      showError('Имя пользователя может содержать только буквы, цифры и _');
      return;
    }

    // Запрещённые имена пользователей (вводящие в заблуждение)
    const RESERVED_USERNAMES = [
      'admin','administrator','support','help','moderator','mod','system','official',
      'owner','root','superuser','staff','team','iflash','iflash_support','iflash_admin',
      'iflash_team','iflash_official','customer_support','helpdesk','techsupport',
      'bot','autobot','service','notification','notifications','noreply','no_reply',
      'security','abuse','postmaster','webmaster','info','contact','operator',
      'manager','ceo','cto','founder','developer','dev','api','server',
      'channel','group','chat','messenger','message','deleted','unknown','anonymous',
      'everyone','here','all','nobody','null','undefined','test','testing',
      'verified','official_support','tech_support','customer_service'
    ];
    if (RESERVED_USERNAMES.includes(username.toLowerCase())) {
      showError('Это имя пользователя зарезервировано и недоступно.');
      return;
    }

    if (password.length < 6) {
      showError('Пароль должен быть не менее 6 символов.');
      return;
    }

    if (password !== confirmPassword) {
      showError('Пароли не совпадают.');
      return;
    }

    // Валидация формата инвайт-кода
    if (!/^IFlash_[a-zA-Z0-9]{16}$/.test(inviteCode)) {
      showError('Введите корректный инвайт-код (формат: IFlash_xxxxxxxxxxxxxxxx).');
      return;
    }

    const statusEl = getEl('username-status');
    if (statusEl && statusEl.classList.contains('status-error')) {
      showError('Это имя пользователя недоступно.');
      return;
    }

    const inviteStatusEl = getEl('invite-status');
    if (inviteStatusEl && inviteStatusEl.classList.contains('status-error')) {
      showError('Инвайт-код недействителен или уже использован.');
      return;
    }

    setButtonLoading(btn, true, 'Зарегистрироваться');

    try {
      // Проверяем инвайт-код перед регистрацией
      const { data: inviteValid, error: inviteCheckError } = await window.supabaseClient
        .rpc('check_invite_code', { p_code: inviteCode });

      if (inviteCheckError || !inviteValid) {
        showError('Инвайт-код недействителен или уже использован.');
        setButtonLoading(btn, false, 'Зарегистрироваться');
        return;
      }

      // Финальная проверка username
      const { data: existingUser } = await window.supabaseClient
        .from('profiles')
        .select('id')
        .eq('username', username)
        .maybeSingle();

      if (existingUser) {
        showError('Это имя пользователя уже занято.');
        setButtonLoading(btn, false, 'Зарегистрироваться');
        return;
      }

      // Регистрация через Supabase Auth (без подтверждения email)
      // invite_code в metadata — триггер в БД прочитает его и пометит код как использованный
      const { data: authData, error: authError } = await window.supabaseClient.auth.signUp({
        email,
        password,
        options: {
          data: {
            username: username,
            invite_code: inviteCode   // <-- триггер on_profile_created_mark_invite использует это
          }
        }
      });

      if (authError) {
        if (authError.message.includes('already registered')) {
          showError('Этот email уже зарегистрирован. Если вы ранее удаляли аккаунт с этим email — используйте другой email или обратитесь в поддержку.');
        } else {
          showError('Ошибка регистрации: ' + authError.message);
        }
        setButtonLoading(btn, false, 'Зарегистрироваться');
        return;
      }

      // Supabase может вернуть пользователя без сессии, если email уже существует
      // (fake signup — identities пустой массив). Это происходит когда аккаунт был удалён
      // но auth.users не очищен полностью.
      if (authData.user && authData.user.identities && authData.user.identities.length === 0) {
        showError('Этот email уже зарегистрирован. Если вы удаляли аккаунт — используйте другой email или обратитесь в поддержку.');
        setButtonLoading(btn, false, 'Зарегистрироваться');
        return;
      }

      if (authData.user) {
        // Создаём или обновляем профиль через upsert.
        // Триггер on_profile_created мог уже создать строку — upsert не упадёт с 409.
        const { error: profileError } = await window.supabaseClient
          .from('profiles')
          .upsert({
            id: authData.user.id,
            username: username,
            avatar_url: null
          }, { onConflict: 'id' });

        if (profileError) {
          // Просто логируем — НЕ прерываемся, чтобы инвайт-код всё равно был помечен
          console.warn('Профиль уже существует или ошибка upsert:', profileError);
        }

        // Помечаем инвайт-код как использованный через RPC (SECURITY DEFINER обходит RLS).
        // Вызываем ВСЕГДА — даже если профиль уже был создан триггером.
        try {
          const { error: inviteRpcErr } = await window.supabaseClient
            .rpc('use_invite_code', { p_code: inviteCode, p_user_id: authData.user.id });
          if (inviteRpcErr) {
            console.error('Ошибка пометки инвайта (RPC):', inviteRpcErr);
          }
        } catch (inviteErr) {
          console.error('Ошибка использования инвайта:', inviteErr);
        }

        // Сразу входим — Supabase автоматически выдаёт сессию
        // Если в Dashboard включено "Email confirmations", вход произойдёт после клика по письму.
        // Для отключения: Authentication → Settings → "Enable email confirmations" = OFF
        if (authData.session) {
          // Сессия создана — пользователь уже вошёл
          window.App && window.App.onAuthSuccess(authData.user);
        } else {
          showError('Регистрация успешна! Войдите в аккаунт.');
          switchTab('login');
          getEl('login-email').value = email;
        }
      }
    } catch (err) {
      showError('Произошла непредвиденная ошибка. Попробуйте снова.');
      console.error('Ошибка регистрации:', err);
    } finally {
      setButtonLoading(btn, false, 'Зарегистрироваться');
    }
  }

  // ---- Вход ----
  async function handleLogin(e) {
    e.preventDefault();

    const email = getEl('login-email').value.trim();
    const password = getEl('login-password').value;
    const btn = getEl('login-btn');

    if (!email || !password) {
      showError('Введите email и пароль.');
      return;
    }

    setButtonLoading(btn, true, 'Войти');

    try {
      const { data, error } = await window.supabaseClient.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        if (error.message.includes('Invalid login credentials')) {
          showError('Неверный email или пароль.');
        } else if (error.message.includes('Email not confirmed')) {
          showError('Подтвердите email. Проверьте почту или отключите подтверждение в Supabase Dashboard.');
        } else {
          showError('Ошибка входа: ' + error.message);
        }
        return;
      }

      if (data.user) {
        window.App && window.App.onAuthSuccess(data.user);
      }
    } catch (err) {
      showError('Произошла непредвиденная ошибка.');
      console.error('Ошибка входа:', err);
    } finally {
      setButtonLoading(btn, false, 'Войти');
    }
  }

  // ---- Выход ----
  async function handleLogout() {
    try {
      // Сначала ставим статус оффлайн (last_seen в прошлое)
      if (window.Chat && window.Chat._setOffline) {
        window.Chat._setOffline();
        await new Promise(r => setTimeout(r, 200)); // дать fetch отправиться
      }
      // Удаляем сессию из БД ДО signOut, пока токен ещё валиден
      const sessionId = localStorage.getItem('iflash_session_id');
      if (sessionId) {
        await window.supabaseClient.from('user_sessions').delete().eq('id', sessionId);
        localStorage.removeItem('iflash_session_id');
      }
      await window.supabaseClient.auth.signOut();
      window.App && window.App.onLogout();
    } catch (err) {
      console.error('Ошибка выхода:', err);
      // Даже при ошибке — выкидываем
      window.App && window.App.onLogout();
    }
  }

  // ---- Инициализация обработчиков событий ----
  function init() {
    // Вкладки
    const tabLogin = getEl('tab-login');
    const tabRegister = getEl('tab-register');
    if (tabLogin) tabLogin.addEventListener('click', () => switchTab('login'));
    if (tabRegister) tabRegister.addEventListener('click', () => switchTab('register'));

    // Форма входа
    const loginForm = getEl('login-form');
    if (loginForm) loginForm.addEventListener('submit', handleLogin);

    // Форма регистрации
    const registerForm = getEl('register-form');
    if (registerForm) registerForm.addEventListener('submit', handleRegister);

    // Живая проверка пароля
    const regPassword = getEl('reg-password');
    if (regPassword) {
      regPassword.addEventListener('input', (e) => {
        updatePasswordStrength(e.target.value);
      });
    }

    // Живая проверка username с задержкой
    const regUsername = getEl('reg-username');
    if (regUsername) {
      regUsername.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        clearTimeout(usernameCheckTimer);
        usernameCheckTimer = setTimeout(() => {
          checkUsernameAvailability(val);
        }, 500);
      });
    }

    // Живая проверка инвайт-кода с задержкой
    const regInvite = getEl('reg-invite');
    if (regInvite) {
      regInvite.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        clearTimeout(inviteCheckTimer);
        inviteCheckTimer = setTimeout(() => {
          checkInviteCode(val);
        }, 600);
      });
    }

    // Показ/скрытие пароля
    document.querySelectorAll('.toggle-password').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const targetId = e.currentTarget.dataset.target;
        const input = getEl(targetId);
        if (!input) return;
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';
        e.currentTarget.textContent = isHidden ? '🙈' : '👁';
      });
    });
  }

  // ---- Очистка всех полей форм (вызывается при выходе/открытии auth) ----
  function clearForms() {
    // Поля входа
    const loginEmail    = getEl('login-email');
    const loginPassword = getEl('login-password');
    if (loginEmail)    loginEmail.value    = '';
    if (loginPassword) loginPassword.value = '';

    // Поля регистрации
    const regEmail    = getEl('reg-email');
    const regUsername = getEl('reg-username');
    const regPassword = getEl('reg-password');
    const regConfirm  = getEl('reg-confirm-password');
    const regInvite   = getEl('reg-invite');
    if (regEmail)    regEmail.value    = '';
    if (regUsername) regUsername.value = '';
    if (regPassword) regPassword.value = '';
    if (regConfirm)  regConfirm.value  = '';
    if (regInvite)   regInvite.value   = '';

    // Сбрасываем индикаторы валидации
    const usernameStatus = getEl('username-status');
    if (usernameStatus) { usernameStatus.textContent = ''; usernameStatus.className = 'field-status'; }
    const inviteStatus = getEl('invite-status');
    if (inviteStatus)   { inviteStatus.textContent   = ''; inviteStatus.className   = 'field-status'; }

    // Сбрасываем индикатор сложности пароля
    updatePasswordStrength('');

    // Сбрасываем видимость паролей (возвращаем тип password + эмодзи глаза)
    document.querySelectorAll('.toggle-password').forEach(btn => {
      const targetId = btn.dataset.target;
      const input = getEl(targetId);
      if (input) input.type = 'password';
      btn.textContent = '👁';
    });

    // Очищаем ошибку
    const authError = getEl('auth-error');
    if (authError) { authError.textContent = ''; authError.classList.remove('visible'); }
  }

  // ---- Публичный API ----
  return {
    init,
    handleLogout,
    switchTab,
    clearForms
  };
})();

// Инициализация после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
  Auth.init();
});
