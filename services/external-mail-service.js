/**
 * 外部邮箱 Provider
 * 兼容 Cloudflare Temp Email / Cloud Mail 的收件 API。
 */

const { ImapFlow } = require('imapflow');

const DEFAULT_LIMIT = 20;
const QQ_IMAP_HOST = 'imap.qq.com';
const QQ_IMAP_PORT = 993;
const IMAP_BODY_PREVIEW_BYTES = 128 * 1024;
const IMAP_BODY_TEXT_MAX_CHARS = 120000;

function firstNonEmpty(values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function normalizeBaseUrl(value = '') {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    url.hash = '';
    url.search = '';
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return '';
  }
}

function joinUrl(baseUrl, pathname) {
  const base = normalizeBaseUrl(baseUrl);
  const path = String(pathname || '').trim();
  if (!base || !path) return base;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

function parseProviderConfig(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  const raw = String(value || '').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {}

  const config = {};
  for (const part of raw.split(/[;,]/)) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) config[key] = val;
  }
  return config;
}

function normalizeProvider(value = '') {
  const provider = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['cloudflare-temp-mail', 'cloudflare-temp-email', 'cloudflare'].includes(provider)) {
    return 'cloudflare-temp-mail';
  }
  if (['cloud-mail', 'cloudmail'].includes(provider)) {
    return 'cloud-mail';
  }
  if (['qq-mail', 'qqmail', 'qq'].includes(provider)) {
    return 'qq-mail';
  }
  return 'outlook';
}

function getAccountMailProvider(account = {}) {
  return normalizeProvider(account.mailProvider || account.provider || account.mail_provider);
}

function getAccountProviderConfig(account = {}) {
  return parseProviderConfig(account.mailConfig || account.providerConfig || account.mail_config);
}

function buildCloudflareHeaders(config = {}) {
  const headers = { Accept: 'application/json' };
  const adminAuth = firstNonEmpty([
    config.adminAuth,
    config.admin_auth,
    config.xAdminAuth,
    config.adminToken,
    config.cloudflareTempEmailAdminAuth,
  ]);
  const customAuth = firstNonEmpty([
    config.customAuth,
    config.custom_auth,
    config.xCustomAuth,
    config.customToken,
    config.cloudflareTempEmailCustomAuth,
  ]);
  if (adminAuth) headers['x-admin-auth'] = adminAuth;
  if (customAuth) headers['x-custom-auth'] = customAuth;
  return headers;
}

function buildCloudMailHeaders(config = {}, token = '') {
  const headers = { Accept: 'application/json' };
  const resolvedToken = firstNonEmpty([token, config.token, config.cloudMailToken]);
  if (resolvedToken) headers.Authorization = resolvedToken;
  return headers;
}

async function requestJson(url, options = {}) {
  const { timeoutMs: rawTimeoutMs, acceptBusinessCodes, ...fetchOptions } = options;
  const timeoutMs = Number(rawTimeoutMs) || 20000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text;
    }
    if (!res.ok) {
      const message = data?.message || data?.error || data?.msg || text || `HTTP ${res.status}`;
      throw new Error(message);
    }
    if (
      data &&
      typeof data === 'object' &&
      Array.isArray(acceptBusinessCodes) &&
      'code' in data &&
      !acceptBusinessCodes.includes(Number(data.code))
    ) {
      throw new Error(data.message || data.msg || `code=${data.code}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeDomain(value = '') {
  let domain = String(value || '').trim().toLowerCase();
  if (!domain) return '';
  domain = domain.replace(/^@+/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : '';
}

function getDomainRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.domains,
    payload.DOMAINS,
    payload.data?.domains,
    payload.data?.DOMAINS,
    payload.payload?.domains,
    payload.payload?.DOMAINS,
    payload.result?.domains,
    payload.result?.DOMAINS,
  ];
  const row = candidates.find(Array.isArray);
  if (row) return row;
  const text = firstNonEmpty([
    payload.domains,
    payload.DOMAINS,
    payload.data?.domains,
    payload.data?.DOMAINS,
    payload.payload?.domains,
    payload.payload?.DOMAINS,
  ]);
  return text ? text.split(/[\s,;，、]+/) : [];
}

function normalizeDomains(values) {
  const domains = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const domain = normalizeDomain(value);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  return domains;
}

function resolveTargetEmail(account = {}, config = {}) {
  const lookupMode = String(config.lookupMode || config.lookup_mode || '').trim().toLowerCase();
  const receiveMailbox = firstNonEmpty([
    config.receiveMailbox,
    config.receive_mailbox,
    config.targetEmail,
    config.target_email,
  ]).toLowerCase();
  if (lookupMode === 'receive-mailbox' && receiveMailbox) return receiveMailbox;
  return String(account.email || '').trim().toLowerCase();
}

function getRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.data,
    payload.items,
    payload.messages,
    payload.mails,
    payload.results,
    payload.rows,
    payload.list,
    payload.records,
    payload?.data?.list,
    payload?.data?.records,
    payload?.data?.rows,
  ];
  return candidates.find(Array.isArray) || [];
}

function stripHtml(value = '') {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(value) {
  if (!value && value !== 0) return new Date().toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = value > 0 && value < 100000000000 ? value * 1000 : value;
    return new Date(timestamp).toISOString();
  }
  let source = String(value || '').trim();
  if (/^\d+$/.test(source)) {
    const numeric = Number(source);
    if (Number.isFinite(numeric)) {
      const timestamp = numeric > 0 && numeric < 100000000000 ? numeric * 1000 : numeric;
      return new Date(timestamp).toISOString();
    }
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(source)) {
    source = `${source.replace(' ', 'T')}Z`;
  } else {
    source = source.replace(' ', 'T');
  }
  const parsed = Date.parse(source);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value || '');
}

function normalizeMessage(row = {}, protocol = 'external') {
  const html = firstNonEmpty([row.html, row.html_content, row.htmlContent, row.body_html, row.bodyHtml, row.content]);
  const text = firstNonEmpty([
    row.text,
    row.text_content,
    row.textContent,
    row.plain,
    row.plain_text,
    row.plainText,
    row.body_text,
    row.bodyText,
    row.preview,
    row.bodyPreview,
    row.snippet,
    row.summary,
    row.body,
  ]);
  const recipient = firstNonEmpty([
    row.address,
    row.mail_address,
    row.email,
    row.recipient,
    row.toEmail,
    row.to_email,
  ]).toLowerCase();
  const from = firstNonEmpty([row.from, row.sender, row.mail_from, row.sendEmail, row.send_email, row.mailFrom]);
  const bodyText = text || stripHtml(html) || stripHtml(row.raw || row.source || row.mime || row.message || '');

  return {
    id: firstNonEmpty([row.id, row.mail_id, row.emailId, row.mailId]),
    subject: firstNonEmpty([row.subject, row.title]),
    from,
    fromName: from,
    date: normalizeDate(firstNonEmpty([
      row.receivedDateTime,
      row.received_at,
      row.createTime,
      row.create_time,
      row.createdAt,
      row.created_at,
      row.date,
    ])),
    bodyPreview: bodyText,
    bodyText,
    bodyHtml: html,
    protocol,
    recipient,
  };
}

function normalizeImapMessage(message, protocol = 'imap') {
  const from = message.from || '';
  const bodyText = message.bodyText || stripHtml(message.bodyHtml || '');
  return {
    id: message.messageId || '',
    messageId: message.messageId || '',
    subject: message.subject || '(无主题)',
    from,
    fromName: message.fromName || from,
    date: normalizeDate(message.date),
    bodyPreview: (message.bodyPreview || bodyText).substring(0, 240),
    bodyText: bodyText.substring(0, IMAP_BODY_TEXT_MAX_CHARS),
    bodyHtml: message.bodyHtml || '',
    protocol,
    recipient: message.recipient || '',
  };
}

function messageHasBody(row = {}) {
  return Boolean(firstNonEmpty([
    row.html,
    row.html_content,
    row.htmlContent,
    row.body_html,
    row.bodyHtml,
    row.content,
    row.text,
    row.text_content,
    row.textContent,
    row.plain,
    row.plain_text,
    row.plainText,
    row.body_text,
    row.bodyText,
    row.body,
    row.raw,
    row.source,
    row.mime,
    row.message,
  ]));
}

function unwrapRow(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return payload.data || payload.mail || payload.message || payload.item || payload;
}

function filterMessages(messages, account, options = {}, targetEmail = '') {
  const target = String(targetEmail || account.email || '').trim().toLowerCase();
  const keyword = String(options.keyword || '').trim().toLowerCase();
  const sender = String(options.sender || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(50, Number(options.limit) || DEFAULT_LIMIT));

  return messages
    .filter(message => !target || !message.recipient || message.recipient === target)
    .filter(message => {
      if (!keyword) return true;
      const text = [message.subject, message.from, message.bodyPreview, message.bodyText].join(' ').toLowerCase();
      return text.includes(keyword);
    })
    .filter(message => !sender || String(message.from || '').toLowerCase().includes(sender))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, limit);
}

async function fetchCloudflareTempMail(account, options = {}) {
  const config = getAccountProviderConfig(account);
  const baseUrl = normalizeBaseUrl(config.baseUrl || config.url || config.cloudflareTempEmailBaseUrl);
  if (!baseUrl) throw new Error('Cloudflare Temp Mail 缺少 baseUrl');
  const targetEmail = resolveTargetEmail(account, config);

  const url = new URL(joinUrl(baseUrl, '/admin/mails'));
  url.searchParams.set('limit', String(Math.max(1, Math.min(50, Number(options.limit) || DEFAULT_LIMIT))));
  if (targetEmail) url.searchParams.set('address', targetEmail);

  const headers = buildCloudflareHeaders(config);
  const payload = await requestJson(url.toString(), {
    method: 'GET',
    headers,
  });
  const rows = getRows(payload);
  const enrichedRows = await Promise.all(rows.map(async row => {
    if (messageHasBody(row)) return row;
    const id = firstNonEmpty([row.id, row.mail_id, row.emailId, row.mailId]);
    if (!id) return row;
    try {
      const detail = await requestJson(joinUrl(baseUrl, `/admin/mails/${encodeURIComponent(id)}`), {
        method: 'GET',
        headers,
      });
      return { ...row, ...unwrapRow(detail) };
    } catch {
      return row;
    }
  }));
  const emails = filterMessages(
    enrichedRows.map(row => normalizeMessage(row, 'cloudflare-temp-mail')),
    account,
    options,
    targetEmail
  );
  return { success: true, emails, count: emails.length, protocol: 'cloudflare-temp-mail' };
}

async function fetchCloudflareTempMailDomains(input = {}) {
  const config = typeof input === 'string' ? parseProviderConfig(input) : input;
  const baseUrl = normalizeBaseUrl(config.baseUrl || config.url || config.cloudflareTempEmailBaseUrl);
  if (!baseUrl) throw new Error('Cloudflare Temp Mail 缺少 baseUrl');

  let openSettingsError = null;
  try {
    const payload = await requestJson(joinUrl(baseUrl, '/open_api/settings'), {
      method: 'GET',
      headers: buildCloudflareHeaders({ customAuth: config.customAuth || config.custom_auth }),
    });
    const domains = normalizeDomains(getDomainRows(payload));
    if (domains.length > 0) {
      return { domains, source: 'open_api/settings' };
    }
    openSettingsError = new Error('公开设置未返回可用域名');
  } catch (err) {
    openSettingsError = err;
  }

  const adminAuth = firstNonEmpty([config.adminAuth, config.admin_auth, config.xAdminAuth, config.adminToken]);
  if (!adminAuth) {
    throw openSettingsError || new Error('未获取到可用域名');
  }

  const payload = await requestJson(joinUrl(baseUrl, '/admin/worker/configs'), {
    method: 'GET',
    headers: buildCloudflareHeaders(config),
  });
  const domains = normalizeDomains(getDomainRows(payload));
  if (domains.length === 0) {
    throw openSettingsError || new Error('管理配置未返回可用域名');
  }
  return { domains, source: 'admin/worker/configs' };
}

async function fetchCloudMailToken(config) {
  const existing = firstNonEmpty([config.token, config.cloudMailToken]);
  if (existing) return existing;
  const email = firstNonEmpty([config.adminEmail, config.email, config.username]);
  const password = firstNonEmpty([config.adminPassword, config.password]);
  if (!email || !password) return '';

  const baseUrl = normalizeBaseUrl(config.baseUrl || config.url || config.cloudMailBaseUrl);
  const payload = await requestJson(joinUrl(baseUrl, '/api/public/genToken'), {
    method: 'POST',
    headers: { ...buildCloudMailHeaders(config, ''), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    acceptBusinessCodes: [200],
  });
  return firstNonEmpty([payload?.data?.token, payload?.token, payload?.data?.accessToken, payload?.accessToken]);
}

async function fetchCloudMail(account, options = {}) {
  const config = getAccountProviderConfig(account);
  const baseUrl = normalizeBaseUrl(config.baseUrl || config.url || config.cloudMailBaseUrl);
  if (!baseUrl) throw new Error('Cloud Mail 缺少 baseUrl');
  const token = await fetchCloudMailToken({ ...config, baseUrl });
  if (!token) throw new Error('Cloud Mail 缺少 token 或管理员账号密码');
  const targetEmail = resolveTargetEmail(account, config);

  const payload = await requestJson(joinUrl(baseUrl, '/api/public/emailList'), {
    method: 'POST',
    headers: { ...buildCloudMailHeaders(config, token), 'Content-Type': 'application/json' },
    acceptBusinessCodes: [200],
    body: JSON.stringify({
      toEmail: targetEmail,
      type: 0,
      isDel: 0,
      timeSort: 'desc',
      num: 1,
      size: Math.max(1, Math.min(50, Number(options.limit) || DEFAULT_LIMIT)),
    }),
  });
  const emails = filterMessages(getRows(payload).map(row => normalizeMessage(row, 'cloud-mail')), account, options, targetEmail);
  return { success: true, emails, count: emails.length, protocol: 'cloud-mail' };
}

async function fetchQqMail(account, options = {}) {
  const config = getAccountProviderConfig(account);
  const mailboxEmail = firstNonEmpty([
    config.mailboxEmail,
    config.mailbox_email,
    config.email,
    config.username,
  ]).toLowerCase();
  const authCode = firstNonEmpty([
    config.authCode,
    config.auth_code,
    config.authorizationCode,
    config.password,
  ]);

  if (!mailboxEmail) throw new Error('QQ 邮箱缺少 mailboxEmail');
  if (!authCode) throw new Error('QQ 邮箱缺少 IMAP 授权码');

  const client = new ImapFlow({
    host: QQ_IMAP_HOST,
    port: QQ_IMAP_PORT,
    secure: true,
    auth: {
      user: mailboxEmail,
      pass: authCode,
    },
    clientInfo: {
      name: 'chatgpt-session-forge',
      version: '1.0.0',
      vendor: 'local',
    },
    disableAutoIdle: true,
    disableAutoEnable: true,
    disableCompression: true,
    logger: false,
    tls: {
      servername: QQ_IMAP_HOST,
      minVersion: 'TLSv1.2',
    },
    connectionTimeout: 30000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });

  try {
    await client.connect();
    const mailbox = await client.getMailboxLock('INBOX');
    try {
      const limit = Math.max(1, Math.min(50, Number(options.limit) || DEFAULT_LIMIT));
      const uids = await resolveRecentImapUids(client, limit, Boolean(options.keyword || options.sender));
      if (uids.length === 0) {
        return { success: true, emails: [], count: 0, protocol: 'qq-mail' };
      }

      const messages = await fetchImapMessageSummaries(client, uids, mailboxEmail);
      await hydrateImapMessageBodies(client, messages);
      const emails = filterMessages(
        messages.map(message => normalizeImapMessage(message, 'qq-mail')),
        { ...account, email: '' },
        options,
        ''
      );
      return { success: true, emails, count: emails.length, protocol: 'qq-mail' };
    } finally {
      mailbox.release();
    }
  } catch (err) {
    throw new Error(normalizeQqImapError(err));
  } finally {
    await client.logout().catch(() => {});
  }
}

async function resolveRecentImapUids(client, limit, hasFilters) {
  const wanted = Math.max(limit, hasFilters ? Math.min(80, limit * 4) : limit);
  const exists = Number(client.mailbox?.exists || 0);
  if (exists <= 0) return [];

  const sequenceStart = Math.max(1, exists - Math.max(wanted, 20) + 1);
  const uids = [];
  for await (const msg of client.fetch(`${sequenceStart}:*`, { uid: true, internalDate: true })) {
    if (msg.uid) uids.push(msg.uid);
  }
  return uids.sort((a, b) => b - a).slice(0, Math.max(wanted, limit));
}

async function fetchImapMessageSummaries(client, uids, recipient = '') {
  const messages = [];
  for await (const msg of client.fetch(uids, {
    uid: true,
    envelope: true,
    bodyStructure: true,
    internalDate: true,
  }, { uid: true })) {
    const from = firstAddress(msg.envelope?.from);
    messages.push({
      uid: msg.uid,
      messageId: msg.envelope?.messageId || `qq-imap-${msg.uid}`,
      subject: msg.envelope?.subject || '(无主题)',
      from: from?.address || '',
      fromName: from?.name || '',
      date: (msg.envelope?.date || msg.internalDate || new Date()).toISOString(),
      bodyText: '',
      bodyPreview: '',
      bodyHtml: '',
      recipient,
      bodyPart: findPreferredImapBodyPart(msg.bodyStructure),
    });
  }
  return messages;
}

async function hydrateImapMessageBodies(client, messages) {
  for (const message of messages) {
    try {
      if (message.bodyPart?.part) {
        const fetched = await client.fetchOne(message.uid, {
          uid: true,
          bodyParts: [{ key: message.bodyPart.part, start: 0, maxLength: IMAP_BODY_PREVIEW_BYTES }],
        }, { uid: true });
        const part = fetched?.bodyParts?.get(message.bodyPart.part);
        if (part) {
          applyImapBodyContent(message, part, message.bodyPart);
          continue;
        }
      }

      const fallback = await client.fetchOne(message.uid, {
        uid: true,
        source: { start: 0, maxLength: IMAP_BODY_PREVIEW_BYTES },
      }, { uid: true });
      if (fallback?.source) applyImapBodyContent(message, fallback.source, { type: 'text/plain' });
    } catch {
      // 信封信息可用于定位邮件，正文读取失败时跳过正文以免整个账号失败。
    }
  }
}

function firstAddress(addresses = []) {
  return Array.isArray(addresses) && addresses.length > 0 ? addresses[0] : null;
}

function findPreferredImapBodyPart(structure) {
  const parts = [];
  walkImapBodyStructure(structure, parts);
  return (
    parts.find(part => part.type === 'text/plain' && part.disposition !== 'attachment') ||
    parts.find(part => part.type === 'text/html' && part.disposition !== 'attachment') ||
    parts.find(part => part.type.startsWith('text/') && part.disposition !== 'attachment') ||
    null
  );
}

function walkImapBodyStructure(node, parts) {
  if (!node) return;
  if (Array.isArray(node.childNodes)) {
    node.childNodes.forEach(child => walkImapBodyStructure(child, parts));
    return;
  }

  const type = String(node.type || '').toLowerCase();
  if (node.part && type.startsWith('text/')) {
    parts.push({
      part: node.part,
      type,
      encoding: String(node.encoding || '').toLowerCase(),
      disposition: String(node.disposition || '').toLowerCase(),
    });
  }
}

function applyImapBodyContent(message, buffer, part = {}) {
  let decoded = decodeImapBody(buffer, part.encoding);
  if (!String(part.type || '').toLowerCase().includes('html')) {
    const extractedHtml = extractHtmlFromMimeSource(decoded);
    if (extractedHtml) {
      decoded = extractedHtml;
      part = { ...part, type: 'text/html' };
    }
  }
  const text = stripHtml(decoded);
  message.bodyText = text.substring(0, IMAP_BODY_TEXT_MAX_CHARS);
  message.bodyPreview = text.substring(0, 240);
  if (part.type === 'text/html') message.bodyHtml = decoded;
}

function extractHtmlFromMimeSource(value = '') {
  const raw = String(value || '');
  const htmlStart = raw.search(/<html[\s>]/i);
  if (htmlStart >= 0) return raw.slice(htmlStart);

  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd >= 0) {
    const body = raw.slice(headerEnd).trim();
    if (/<body[\s>]|<table[\s>]|<p[\s>]/i.test(body)) return body;
  }

  return '';
}

function decodeImapBody(buffer, encoding = '') {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const normalizedEncoding = String(encoding || '').toLowerCase();

  if (normalizedEncoding === 'base64') {
    const compact = raw.toString('utf8').replace(/\s+/g, '');
    return compact ? Buffer.from(compact, 'base64').toString('utf8') : '';
  }

  if (normalizedEncoding === 'quoted-printable') {
    return decodeQuotedPrintable(raw.toString('utf8'));
  }

  return raw.toString('utf8');
}

function decodeQuotedPrintable(value = '') {
  return String(value || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function normalizeQqImapError(err) {
  const message = err?.message || String(err || '未知错误');
  if (/AUTHENTICATE|Authentication|Invalid credentials|NO AUTHENTICATE|LOGIN failed|AUTH failed/i.test(message)) {
    return `QQ 邮箱 IMAP 认证失败：请确认已开启 IMAP 服务，并使用 QQ 邮箱授权码而不是 QQ 密码。${message}`;
  }
  if (/ETIMEDOUT|ESOCKET|ECONN|Greeting never received|Socket timeout|Timed out/i.test(message)) {
    return `QQ 邮箱 IMAP 连接超时：${message}`;
  }
  if (/TLS|SSL|secure|socket disconnected|connection was established|ECONNRESET/i.test(message)) {
    return `QQ 邮箱 IMAP TLS 连接失败：请确认当前网络或代理允许直连 imap.qq.com:993；如使用 Clash/TUN/代理，请尝试切换节点、开启直连规则或临时关闭代理后重试。${message}`;
  }
  return message;
}

async function fetchEmails(account, options = {}) {
  const provider = getAccountMailProvider(account);
  if (provider === 'cloudflare-temp-mail') return fetchCloudflareTempMail(account, options);
  if (provider === 'cloud-mail') return fetchCloudMail(account, options);
  if (provider === 'qq-mail') return fetchQqMail(account, options);
  throw new Error(`不支持的外部邮箱 Provider: ${provider}`);
}

module.exports = {
  fetchEmails,
  fetchCloudflareTempMailDomains,
  getAccountMailProvider,
  getAccountProviderConfig,
  normalizeProvider,
};
