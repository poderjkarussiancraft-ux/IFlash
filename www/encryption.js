// ============================================================
// encryption.js — E2EE для iflash Messenger
//
// Алгоритм: ECDH P-256 (обмен ключами) + AES-256-GCM (шифрование)
// API:       window.crypto.subtle (Web Crypto API)
//
// Схема:
//   • Каждый аккаунт имеет ОДНУ ключевую пару (не по устройству, а по аккаунту).
//   • Публичный ключ хранится в profiles.public_key (открыто, в Base64).
//   • Приватный ключ зашифрован в profiles.encrypted_private_key.
//   • Шифрование приватного ключа: AES-GCM, ключ = PBKDF2(userId, CLOUD_SALT).
//   • localStorage — только кэш. Источник правды — облако.
//   • Для чата A↔B: shared_key = ECDH(A.priv, B.pub) = ECDH(B.priv, A.pub)
//   • Сообщение: AES-GCM(plaintext, shared_key, random_iv)
//   • В Supabase: "__E2EE__<base64(iv + ciphertext)>"
// ============================================================

const Encryption = (() => {
  const _subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;

  if (!_subtle) {
    console.warn('[E2EE] ⚠️ crypto.subtle недоступен (требуется HTTPS или localhost). E2EE отключено.');
    return {
      initUser:          async () => {},
      encryptFor:        async (text) => text,
      decryptFrom:       async (text) => text,
      isEncrypted:       (c) => typeof c === 'string' && c.startsWith('__E2EE__'),
      preloadKeys:       async () => {},
      getMyPublicKeyB64: () => null,
      resetKeys:         async () => {},
      reDecryptVisible:  async () => {},
      PREFIX: '__E2EE__',
    };
  }

  const ECDH_PARAMS  = { name: 'ECDH', namedCurve: 'P-256' };
  const AES_PARAMS   = { name: 'AES-GCM', length: 256 };
  const PREFIX       = '__E2EE__';
  const STORAGE_KEY  = 'iflash_e2ee_v1';
  const IV_BYTES     = 12;

  // Соль для PBKDF2. Изменение этой соли сделает все старые бэкапы нечитаемыми.
  const CLOUD_SALT = 'iflash_e2ee_cloud_v2_2025';

  let _myKeyPair   = null;          // { publicKey, privateKey, publicKeyB64 }
  let _initDone    = false;         // true после успешной initUser
  let _initUserId  = null;          // userId последней инициализации
  const _pubKeyCache = new Map();   // userId → CryptoKey
  const _aesKeyCache = new Map();   // userId → CryptoKey

  // ── Утилиты ────────────────────────────────────────────────
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const bytesToB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  // ── Криптографические примитивы ────────────────────────────
  const generateKeyPair  = () => _subtle.generateKey(ECDH_PARAMS, true, ['deriveKey']);
  const exportPublicKey  = (k) => _subtle.exportKey('raw',  k).then(bytesToB64);
  const exportPrivateKey = (k) => _subtle.exportKey('pkcs8',k).then(bytesToB64);
  const importPublicKey  = (b64) => _subtle.importKey('raw',   b64ToBytes(b64), ECDH_PARAMS, true, []);
  const importPrivateKey = (b64) => _subtle.importKey('pkcs8', b64ToBytes(b64), ECDH_PARAMS, true, ['deriveKey']);

  async function deriveAesKey(myPrivateKey, theirPublicKey) {
    return _subtle.deriveKey(
      { name: 'ECDH', public: theirPublicKey },
      myPrivateKey,
      AES_PARAMS,
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function getAesKey(theirUserId, bypassCache = false) {
    if (!bypassCache && _aesKeyCache.has(theirUserId)) return _aesKeyCache.get(theirUserId);
    if (!_myKeyPair) return null;
    const theirPubKey = await getRecipientPublicKey(theirUserId, bypassCache);
    if (!theirPubKey) return null;
    const aesKey = await deriveAesKey(_myKeyPair.privateKey, theirPubKey);
    _aesKeyCache.set(theirUserId, aesKey);
    return aesKey;
  }

  // ── Шифрование / расшифровка сообщений ─────────────────────
  async function encryptText(plaintext, aesKey) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const enc = await _subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(plaintext));
    const combined = new Uint8Array(IV_BYTES + enc.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(enc), IV_BYTES);
    return PREFIX + bytesToB64(combined);
  }

  async function decryptText(encrypted, aesKey) {
    try {
      const raw = b64ToBytes(encrypted.slice(PREFIX.length));
      const iv  = raw.slice(0, IV_BYTES);
      const ct  = raw.slice(IV_BYTES);
      const dec = await _subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
      return new TextDecoder().decode(dec);
    } catch {
      return null;
    }
  }

  async function encryptFor(plaintext, recipientId) {
    if (!_myKeyPair) return plaintext;
    const aesKey = await getAesKey(recipientId);
    if (!aesKey) return plaintext;
    return encryptText(plaintext, aesKey);
  }

  // Расшифровка с авто-ретраем если ключ в кэше устарел
  async function decryptFrom(encrypted, senderId) {
    if (!isEncrypted(encrypted) || !_myKeyPair) return encrypted;

    // Первая попытка — из кэша
    const aesKey = await getAesKey(senderId);
    if (aesKey) {
      const plain = await decryptText(encrypted, aesKey);
      if (plain !== null) return plain;
    }

    // Ключ устарел или неверен — сбрасываем кэш и пробуем заново с DB
    _pubKeyCache.delete(senderId);
    _aesKeyCache.delete(senderId);
    const aesKeyFresh = await getAesKey(senderId, true);
    if (!aesKeyFresh) return encrypted;

    const plainRetry = await decryptText(encrypted, aesKeyFresh);
    return plainRetry ?? encrypted;
  }

  // ============================================================
  // ОБЛАЧНЫЙ БЭКАП (Supabase) — ПРИВАТНЫЙ КЛЮЧ
  // Ключ шифрования = PBKDF2(userId, CLOUD_SALT) — одинаков на всех устройствах
  // ============================================================

  async function _deriveCloudKey(userId) {
    const enc = new TextEncoder();
    const km = await _subtle.importKey('raw', enc.encode(userId), { name: 'PBKDF2' }, false, ['deriveKey']);
    return _subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(CLOUD_SALT), iterations: 200000, hash: 'SHA-256' },
      km, AES_PARAMS, false, ['encrypt', 'decrypt']
    );
  }

  async function _encryptPrivKeyForCloud(privB64, userId) {
    const cloudKey = await _deriveCloudKey(userId);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await _subtle.encrypt({ name: 'AES-GCM', iv }, cloudKey, new TextEncoder().encode(privB64));
    const out = new Uint8Array(IV_BYTES + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), IV_BYTES);
    return bytesToB64(out);
  }

  async function _decryptPrivKeyFromCloud(encB64, userId) {
    try {
      const cloudKey = await _deriveCloudKey(userId);
      const raw = b64ToBytes(encB64);
      const iv  = raw.slice(0, IV_BYTES);
      const ct  = raw.slice(IV_BYTES);
      const dec = await _subtle.decrypt({ name: 'AES-GCM', iv }, cloudKey, ct);
      return new TextDecoder().decode(dec);
    } catch (e) {
      console.error('[E2EE] Не удалось расшифровать облачный ключ:', e.message);
      return null;
    }
  }

  // ── Загрузить сырые данные ключей из profiles ──────────────
  async function _fetchCloudKeyData(userId) {
    if (!window.supabaseClient) return null;
    try {
      const { data, error } = await window.supabaseClient
        .from('profiles')
        .select('public_key, encrypted_private_key')
        .eq('id', userId)
        .maybeSingle();
      if (error) {
        console.warn('[E2EE] Ошибка чтения ключей из облака:', error.message);
        // Если колонок нет — выводим инструкцию
        if (error.message && error.message.includes('column')) {
          console.error('[E2EE] ❌ Необходимо применить SQL в Supabase:\n' +
            'ALTER TABLE profiles ADD COLUMN IF NOT EXISTS public_key TEXT;\n' +
            'ALTER TABLE profiles ADD COLUMN IF NOT EXISTS encrypted_private_key TEXT;');
        }
        return null;
      }
      return data || null;
    } catch (e) {
      console.error('[E2EE] _fetchCloudKeyData exception:', e.message);
      return null;
    }
  }

  // ── Загрузить и расшифровать полную ключевую пару из облака ─
  async function _loadKeyPairFromCloud(userId) {
    const data = await _fetchCloudKeyData(userId);
    if (!data?.public_key || !data?.encrypted_private_key) return null;

    const privB64 = await _decryptPrivKeyFromCloud(data.encrypted_private_key, userId);
    if (!privB64) return null;

    try {
      const publicKey  = await importPublicKey(data.public_key);
      const privateKey = await importPrivateKey(privB64);
      return { publicKey, privateKey, publicKeyB64: data.public_key };
    } catch (e) {
      console.error('[E2EE] Ошибка импорта ключей из облака:', e.message);
      return null;
    }
  }

  // ── Сохранить ключевую пару в облако (несколько стратегий) ─
  async function _saveKeyPairToCloud(userId, pubB64, privB64) {
    if (!window.supabaseClient) { console.error('[E2EE] supabaseClient не доступен!'); return false; }
    try {
      const encPriv = await _encryptPrivKeyForCloud(privB64, userId);
      console.log('[E2EE] Зашифрован приватный ключ для облака, длина:', encPriv.length);

      // Стратегия 1: RPC set_my_e2ee_keys (SECURITY DEFINER, обходит RLS)
      console.log('[E2EE] Попытка 1: RPC set_my_e2ee_keys...');
      const { error: rpcErr } = await window.supabaseClient
        .rpc('set_my_e2ee_keys', { pub_key: pubB64, enc_priv_key: encPriv });
      if (!rpcErr) {
        console.log('[E2EE] ✅ Ключи сохранены в облако (RPC)');
        return true;
      }
      console.error('[E2EE] RPC ОШИБКА:', rpcErr.message, rpcErr.code, rpcErr.details, rpcErr.hint);

      // Стратегия 2: прямой UPDATE обоих полей
      console.log('[E2EE] Попытка 2: UPDATE profiles...');
      const { error: updErr } = await window.supabaseClient
        .from('profiles')
        .update({ public_key: pubB64, encrypted_private_key: encPriv })
        .eq('id', userId);
      if (!updErr) {
        console.log('[E2EE] ✅ Ключи сохранены (UPDATE оба поля)');
        return true;
      }
      console.error('[E2EE] UPDATE ОШИБКА:', updErr.message, updErr.code, updErr.details, updErr.hint);

      // Стратегия 3: только public_key
      console.log('[E2EE] Попытка 3: UPDATE только public_key...');
      const { error: pubErr } = await window.supabaseClient
        .from('profiles')
        .update({ public_key: pubB64 })
        .eq('id', userId);
      if (!pubErr) {
        console.warn('[E2EE] ⚠️ Сохранён только public_key. encrypted_private_key не сохранён.');
        return false;
      }
      console.error('[E2EE] UPDATE public_key ОШИБКА:', pubErr.message, pubErr.code);

      // Стратегия 4: RPC set_my_public_key
      console.log('[E2EE] Попытка 4: RPC set_my_public_key...');
      const { error: pubRpcErr } = await window.supabaseClient
        .rpc('set_my_public_key', { key_b64: pubB64 });
      if (!pubRpcErr) {
        console.warn('[E2EE] ⚠️ Сохранён только public_key через RPC');
        return false;
      }
      console.error('[E2EE] RPC set_my_public_key ОШИБКА:', pubRpcErr.message);

      // Стратегия 5: прямой upsert через insert on conflict
      console.log('[E2EE] Попытка 5: upsert...');
      const { error: upsErr } = await window.supabaseClient
        .from('profiles')
        .upsert({ id: userId, public_key: pubB64, encrypted_private_key: encPriv },
          { onConflict: 'id', ignoreDuplicates: false });
      if (!upsErr) {
        console.log('[E2EE] ✅ Ключи сохранены (UPSERT)');
        return true;
      }
      console.error('[E2EE] UPSERT ОШИБКА:', upsErr.message);

      console.error('[E2EE] ❌ ВСЕ 5 стратегий не сработали. Откройте консоль (F12) и скиньте логи.');
      return false;
    } catch (e) {
      console.error('[E2EE] _saveKeyPairToCloud EXCEPTION:', e.message, e.stack);
      return false;
    }
  }

  // ── localStorage (кэш ключей) ──────────────────────────────
  async function _saveLocalCache(kp) {
    try {
      const pub  = await exportPublicKey(kp.publicKey);
      const priv = await exportPrivateKey(kp.privateKey);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ pub, priv }));
    } catch (e) {
      console.warn('[E2EE] Не удалось сохранить ключи в localStorage:', e.message);
    }
  }

  async function _loadLocalCache() {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (!s) return null;
      const { pub, priv } = JSON.parse(s);
      const publicKey  = await importPublicKey(pub);
      const privateKey = await importPrivateKey(priv);
      return { publicKey, privateKey, publicKeyB64: pub };
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }

  // ── Получить публичный ключ собеседника ─────────────────────
  async function getRecipientPublicKey(userId, bypassCache = false) {
    if (!bypassCache && _pubKeyCache.has(userId)) return _pubKeyCache.get(userId);
    if (!window.supabaseClient) return null;
    try {
      const { data } = await window.supabaseClient
        .from('profiles')
        .select('public_key')
        .eq('id', userId)
        .maybeSingle();
      if (!data?.public_key) return null;
      const key = await importPublicKey(data.public_key);
      _pubKeyCache.set(userId, key);
      return key;
    } catch {
      return null;
    }
  }

  // ── Пакетная предзагрузка ключей ───────────────────────────
  async function preloadKeys(userIds) {
    const unknown = userIds.filter(id => id && !_pubKeyCache.has(id));
    if (!unknown.length || !window.supabaseClient) return;
    try {
      const { data } = await window.supabaseClient
        .from('profiles')
        .select('id, public_key')
        .in('id', unknown);
      if (!data) return;
      for (const { id, public_key } of data) {
        if (!public_key) continue;
        try {
          _pubKeyCache.set(id, await importPublicKey(public_key));
        } catch {}
      }
    } catch {}
  }

  // ============================================================
  // ИНИЦИАЛИЗАЦИЯ — вызывается при каждом входе пользователя
  //
  // Стратегия (ОБЛАКО — источник правды):
  //   1. Проверяем облако — есть ли уже ключевая пара для аккаунта?
  //      a. Если да — пробуем расшифровать.
  //         Если расшифровка упала — fallback на localStorage.
  //      b. Если нет — генерируем новую, сохраняем.
  //   2. localStorage — кэш И резервный вариант.
  // ============================================================
  async function initUser(userId) {
    _initDone   = false;
    _initUserId = userId;
    console.log('[E2EE] Инициализация для пользователя', userId);

    // ── Шаг 1: Пробуем облако ──────────────────────────────────
    const cloudData = await _fetchCloudKeyData(userId);
    const cloudHasKeys = !!(cloudData?.public_key && cloudData?.encrypted_private_key);

    if (cloudHasKeys) {
      console.log('[E2EE] Облако содержит ключи, загружаем...');

      // Быстрый путь: localStorage совпадает с облаком
      const localKp = await _loadLocalCache();
      if (localKp && localKp.publicKeyB64 === cloudData.public_key) {
        _myKeyPair = localKp;
        console.log('[E2EE] ✅ Ключи из localStorage (совпадают с облаком)');
      } else {
        // Декодируем из облака
        _myKeyPair = await _loadKeyPairFromCloud(userId);
        if (_myKeyPair) {
          await _saveLocalCache(_myKeyPair);
          console.log('[E2EE] ✅ Ключи загружены из облака');
        } else {
          // ── Облачный ключ не расшифровался → пробуем localStorage как fallback ──
          console.warn('[E2EE] Облачный ключ не расшифровался, пробуем localStorage...');
          if (localKp) {
            _myKeyPair = localKp;
            console.warn('[E2EE] ⚠️ Используем ключ из localStorage. Пробуем починить облако...');
            // Пытаемся перезаписать облако правильным ключом
            const pub  = await exportPublicKey(localKp.publicKey);
            const priv = await exportPrivateKey(localKp.privateKey);
            const repaired = await _saveKeyPairToCloud(userId, pub, priv);
            if (repaired) {
              console.log('[E2EE] ✅ Облачный ключ успешно обновлён из localStorage');
            }
          } else {
            // Нет ни облачного ни локального — генерируем новый локально
            console.warn('[E2EE] Нет доступного ключа, создаём новый (только для этого устройства)...');
            const raw  = await generateKeyPair();
            const pub  = await exportPublicKey(raw.publicKey);
            const priv = await exportPrivateKey(raw.privateKey);
            _myKeyPair = { ...raw, publicKeyB64: pub };
            await _saveLocalCache(_myKeyPair);
            // Пробуем сохранить в облако (может не получиться если нет SQL)
            await _saveKeyPairToCloud(userId, pub, priv);
          }
        }
      }
    } else if (cloudData && cloudData.public_key && !cloudData.encrypted_private_key) {
      // ── Особый случай: public_key есть, но encrypted_private_key нет ──
      // Это значит что приватный ключ никогда не был сохранён в облако.
      // Пробуем localStorage — там может быть верный ключ.
      console.warn('[E2EE] В облаке только public_key без encrypted_private_key');
      const localKp = await _loadLocalCache();
      if (localKp && localKp.publicKeyB64 === cloudData.public_key) {
        // Локальный ключ совпадает с публичным — используем его и пробуем сохранить приватный
        _myKeyPair = localKp;
        console.log('[E2EE] ✅ Ключи из localStorage (public_key совпадает с облаком)');
        const priv = await exportPrivateKey(localKp.privateKey);
        await _saveKeyPairToCloud(userId, localKp.publicKeyB64, priv);
      } else {
        // Публичный ключ в облаке и localStorage не совпадают — генерируем новые
        console.warn('[E2EE] Public key расхождение, генерируем новые ключи...');
        const raw  = await generateKeyPair();
        const pub  = await exportPublicKey(raw.publicKey);
        const priv = await exportPrivateKey(raw.privateKey);
        _myKeyPair = { ...raw, publicKeyB64: pub };
        await _saveLocalCache(_myKeyPair);
        await _saveKeyPairToCloud(userId, pub, priv);
      }
    } else {
      // ── Шаг 2: Облако пусто — первый запуск аккаунта ──────────
      console.log('[E2EE] Ключей в облаке нет → генерируем новую пару...');

      // Сначала проверим localStorage — вдруг ключ уже генерировался
      const localKp = await _loadLocalCache();
      if (localKp) {
        console.log('[E2EE] Найден локальный ключ, загружаем в облако...');
        _myKeyPair = localKp;
        const pub  = await exportPublicKey(localKp.publicKey);
        const priv = await exportPrivateKey(localKp.privateKey);
        await _saveKeyPairToCloud(userId, pub, priv);
      } else {
        const raw  = await generateKeyPair();
        const pub  = await exportPublicKey(raw.publicKey);
        const priv = await exportPrivateKey(raw.privateKey);
        _myKeyPair = { ...raw, publicKeyB64: pub };
        await _saveLocalCache(_myKeyPair);

        let saved = await _saveKeyPairToCloud(userId, pub, priv);
        if (!saved) {
          await new Promise(r => setTimeout(r, 2000));
          saved = await _saveKeyPairToCloud(userId, pub, priv);
        }
        if (!saved) {
          console.error('[E2EE] ❌ Ключи не удалось сохранить в облако!');
          _showE2eeError(
            'Не удалось сохранить ключи шифрования в облако. ' +
            'На других устройствах сообщения не расшифруются. ' +
            'Проверьте интернет-соединение и наличие колонок public_key / encrypted_private_key в Supabase.'
          );
        } else {
          console.log('[E2EE] ✅ Новая ключевая пара создана и сохранена');
        }
      }
    }

    // ── Шаг 3: Кэшируем свой публичный ключ ────────────────────
    if (_myKeyPair) {
      _pubKeyCache.set(userId, _myKeyPair.publicKey);
      _initDone = true;
    }

    console.log(`[E2EE] ✅ Инициализация завершена, ключ: ${_myKeyPair?.publicKeyB64?.slice(0,12) ?? 'НЕТ'}...`);
  }

  // ── Переоткрыть и перерасшифровать все видимые сообщения ───
  // Вызывается после initUser чтобы переоткрыть сообщения которые не расшифровались
  async function reDecryptVisible() {
    if (!_myKeyPair) return;
    const els = document.querySelectorAll('[data-encrypted-content]');
    if (!els.length) return;
    console.log(`[E2EE] Перерасшифровываем ${els.length} сообщений...`);
    for (const el of els) {
      try {
        const encrypted = el.getAttribute('data-encrypted-content');
        const senderId  = el.getAttribute('data-sender-id');
        if (!encrypted || !senderId) continue;
        const plain = await decryptFrom(encrypted, senderId);
        if (plain && !plain.startsWith(PREFIX)) {
          // Обновляем текстовый контент элемента
          const textEl = el.querySelector('.msg-text') || el;
          if (textEl) {
            textEl.innerHTML = plain.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          }
          el.removeAttribute('data-encrypted-content');
        }
      } catch {}
    }
  }

  // ── UI: тост с ошибкой E2EE ────────────────────────────────
  function _showE2eeError(msg) {
    setTimeout(() => {
      try {
        if (window.Chat && typeof window.Chat.showToast === 'function') {
          window.Chat.showToast('🔒 ' + msg, 'error');
        } else {
          console.error('[E2EE] UI:', msg);
        }
      } catch {}
    }, 1500);
  }

  // ── Сбросить E2EE ключи (из настроек) ─────────────────────
  // ВАЖНО: не зависит от состояния облака — всегда генерирует новую пару
  async function resetKeys(userId) {
    // Очищаем всё
    localStorage.removeItem(STORAGE_KEY);
    _myKeyPair  = null;
    _initDone   = false;
    _pubKeyCache.clear();
    _aesKeyCache.clear();

    console.log('[E2EE] Генерируем новую ключевую пару (сброс)...');
    try {
      const raw  = await generateKeyPair();
      const pub  = await exportPublicKey(raw.publicKey);
      const priv = await exportPrivateKey(raw.privateKey);
      _myKeyPair = { ...raw, publicKeyB64: pub };

      // Сохраняем локально (это работает всегда)
      await _saveLocalCache(_myKeyPair);

      // Пробуем сохранить в облако (с повтором)
      let saved = await _saveKeyPairToCloud(userId, pub, priv);
      if (!saved) {
        await new Promise(r => setTimeout(r, 1500));
        saved = await _saveKeyPairToCloud(userId, pub, priv);
      }
      if (!saved) {
        console.warn('[E2EE] ⚠️ Новый ключ создан локально, но не сохранён в облако. ' +
          'Другие устройства не смогут читать новые сообщения пока не применены SQL-миграции.');
      }

      // Кэшируем свой публичный ключ
      _pubKeyCache.set(userId, _myKeyPair.publicKey);
      _initDone = true;
      console.log('[E2EE] ✅ Ключи сброшены и пересозданы');
    } catch (e) {
      console.error('[E2EE] resetKeys failed:', e.message);
      _showE2eeError('Ошибка при создании ключей: ' + e.message);
    }
  }

  // ── Проверить зашифровано ли сообщение ─────────────────────
  function isEncrypted(content) {
    return typeof content === 'string' && content.startsWith(PREFIX);
  }

  function getMyPublicKeyB64() {
    return _myKeyPair?.publicKeyB64 ?? null;
  }

  // ── Диагностика (вызов: Encryption.debug()) ──────────────────
  async function debug() {
    console.group('[E2EE] === ДИАГНОСТИКА ===');
    console.log('_initDone:', _initDone);
    console.log('_initUserId:', _initUserId);
    console.log('_myKeyPair:', _myKeyPair ? 'есть (pub: ' + (_myKeyPair.publicKeyB64 || '').slice(0,20) + '...)' : 'null');
    console.log('localStorage:', localStorage.getItem(STORAGE_KEY) ? 'есть' : 'нет');

    if (window.supabaseClient && _initUserId) {
      try {
        const { data, error } = await window.supabaseClient
          .from('profiles')
          .select('public_key, encrypted_private_key')
          .eq('id', _initUserId)
          .maybeSingle();
        if (error) {
          console.error('Облако ошибка:', error.message, error.code, error.hint);
        } else {
          console.log('Облако public_key:', data?.public_key ? data.public_key.slice(0,20) + '...' : 'null');
          console.log('Облако encrypted_private_key:', data?.encrypted_private_key ? data.encrypted_private_key.slice(0,20) + '...' : 'null');
        }

        // Проверяем RPC
        const { error: rpcErr } = await window.supabaseClient
          .rpc('set_my_e2ee_keys', { pub_key: 'TEST', enc_priv_key: 'TEST' });
        if (rpcErr) {
          console.error('RPC set_my_e2ee_keys ОШИБКА:', rpcErr.message, rpcErr.code);
          // Откатываем тестовый вызов не нужно — он не прошёл
        } else {
          console.log('RPC set_my_e2ee_keys: ✅ работает');
          // Восстанавливаем реальные ключи из облака
          if (_myKeyPair) {
            const priv = await exportPrivateKey(_myKeyPair.privateKey);
            await _saveKeyPairToCloud(_initUserId, _myKeyPair.publicKeyB64, priv);
          }
        }
      } catch (e) {
        console.error('Диагностика exception:', e.message);
      }
    } else {
      console.warn('supabaseClient или userId отсутствует');
    }
    console.groupEnd();
  }

  return {
    initUser,
    encryptFor,
    decryptFrom,
    preloadKeys,
    isEncrypted,
    getMyPublicKeyB64,
    resetKeys,
    reDecryptVisible,
    debug,
    PREFIX,
  };
})();

window.Encryption = Encryption;
