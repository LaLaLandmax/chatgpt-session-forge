/**
 * 邮件取件模块
 * 双协议并行取件（IMAP + Graph）
 * 
 * 性能优化：
 * 1. 多账号并发取件（并发数 4）
 * 2. 同一账号 IMAP + Graph 并行
 */

const FETCH_CONCURRENCY = 4; // 同时处理的账号数

// ==================== 取件逻辑 ====================
async function fetchEmails(accounts, options = {}) {
  if (accounts.length === 0) {
    showToast('请先选择邮箱', 'warning');
    return;
  }

  const useImap = document.getElementById('toggleImap').checked;
  const useGraph = document.getElementById('toggleGraph').checked;
  const externalAccounts = accounts.filter(account => getAccountProvider(account) !== 'outlook');
  const outlookAccounts = accounts.length - externalAccounts.length;

  if (outlookAccounts > 0 && !useImap && !useGraph) {
    showToast('请至少选择一种协议', 'warning');
    return;
  }

  const protocolCount = (useImap ? 1 : 0) + (useGraph ? 1 : 0);
  const totalSteps = (outlookAccounts * protocolCount) + externalAccounts.length;
  let completedSteps = 0;

  setStatus('loading', '取件中...');
  showProgress(true);
  updateProgress(0, `准备并发取件 ${accounts.length} 个邮箱 (并发${FETCH_CONCURRENCY})...`);
  showSkeletonCards(3);

  const allEmails = [];
  const fatalErrors = [];
  let successfulAccounts = 0;
  renderFetchIssues([]);

  // === 并发池：同时处理多个账号 ===
  async function fetchOneAccount(account, index) {
    const emailShort = account.email.split('@')[0];
    const accountLabel = `[${index + 1}/${accounts.length}] ${emailShort}`;
    const promises = [];
    const provider = getAccountProvider(account);

    if (provider !== 'outlook') {
      try {
        const res = await fetch('/api/fetch-provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: account.email,
            mailProvider: account.mailProvider || account.provider,
            mailConfig: account.mailConfig || account.providerConfig,
            keyword: options.keyword || '',
            limit: options.limit || 10,
            sender: options.sender || '',
          }),
        });
        const result = await res.json();
        completedSteps++;
        updateProgress(Math.round((completedSteps / totalSteps) * 95), `${accountLabel} — ${accountProviderLabel(provider)} ${result.success ? 'OK' : '失败'} ${result.count || 0} 封`);
        if (result.success) successfulAccounts++;
        else fatalErrors.push({ email: account.email, protocol: provider, error: result.error });
        if (result.emails && result.emails.length > 0) {
          result.emails.forEach(e => { e._account = account.email; });
          allEmails.push(...result.emails);
        }
      } catch (err) {
        completedSteps++;
        updateProgress(Math.round((completedSteps / totalSteps) * 95), `${accountLabel} — ${accountProviderLabel(provider)} 失败`);
        fatalErrors.push({ email: account.email, protocol: provider, error: err.message });
      }
      return;
    }

    if (useGraph) {
      promises.push((async () => {
        try {
          const res = await fetch('/api/fetch-graph', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: account.email, clientId: account.clientId,
              refreshToken: account.refreshToken,
              keyword: options.keyword || '', limit: options.limit || 10,
              sender: options.sender || '',
            }),
          });
          const result = await res.json();
          completedSteps++;
          updateProgress(Math.round((completedSteps / totalSteps) * 95), `${accountLabel} — Graph ${result.success ? 'OK' : '失败'} ${result.count || 0} 封`);
          return result;
        } catch (err) {
          completedSteps++;
          updateProgress(Math.round((completedSteps / totalSteps) * 95), `${accountLabel} — Graph 失败`);
          return { success: false, emails: [], protocol: 'graph', error: err.message };
        }
      })());
    }

    if (useImap) {
      promises.push((async () => {
        try {
          const res = await fetch('/api/fetch-imap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: account.email, clientId: account.clientId,
              refreshToken: account.refreshToken,
              keyword: options.keyword || '', limit: options.limit || 10,
              sender: options.sender || '',
            }),
          });
          const result = await res.json();
          completedSteps++;
          updateProgress(Math.round((completedSteps / totalSteps) * 95), `${accountLabel} — IMAP ${result.success ? 'OK' : '失败'} ${result.count || 0} 封`);
          return result;
        } catch (err) {
          completedSteps++;
          updateProgress(Math.round((completedSteps / totalSteps) * 95), `${accountLabel} — IMAP 失败`);
          return { success: false, emails: [], protocol: 'imap', error: err.message };
        }
      })());
    }

    const results = await Promise.all(promises);
    const accountSucceeded = results.some(r => r.success === true);
    if (accountSucceeded) successfulAccounts++;
    else fatalErrors.push(...results.filter(r => !r.success).map(r => ({ email: account.email, protocol: r.protocol, error: r.error })));

    results.forEach(r => {
      if (r.emails && r.emails.length > 0) {
        r.emails.forEach(e => { e._account = account.email; });
        allEmails.push(...r.emails);
      }
    });
  }

  // 固定并发 worker，避免 Outlook IMAP 连接数瞬间冲高。
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, accounts.length) }, async () => {
    while (nextIndex < accounts.length) {
      const currentIndex = nextIndex++;
      await fetchOneAccount(accounts[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);

  updateProgress(97, '去重合并中...');
  const merged = deduplicateEmails(allEmails);
  merged.sort((a, b) => new Date(b.date) - new Date(a.date));

  updateProgress(100, '取件完成 ✅');
  renderEmailList(merged);
  setTimeout(() => showProgress(false), 2000);

  if (fatalErrors.length > 0) {
    const failedAccounts = accounts.length - successfulAccounts;
    renderFetchIssues(fatalErrors);
    setStatus(successfulAccounts > 0 ? 'ready' : 'error', `完成：${successfulAccounts} 成功 / ${failedAccounts} 失败`);
    showToast(`取件完成，但有 ${failedAccounts} 个邮箱协议失败`, successfulAccounts > 0 ? 'warning' : 'error', 5000);
  } else {
    renderFetchIssues([]);
    setStatus('ready', '就绪');
  }

  const imapCount = merged.filter(e => e.protocol === 'imap').length;
  const graphCount = merged.filter(e => e.protocol === 'graph').length;
  const externalCount = merged.length - imapCount - graphCount;
  showToast(`取件完成：共 ${merged.length} 封 (IMAP: ${imapCount} / Graph: ${graphCount} / 外部: ${externalCount})`, 'success', 4000);
  addLog(`取件完成: ${merged.length} 封 (${accounts.length} 个邮箱)`, 'success');
}


// ==================== 邮件渲染 ====================
function renderEmailList(emails) {
  const listEl = document.getElementById('emailList');
  const headerEl = document.getElementById('resultsHeader');
  const imapCountEl = document.getElementById('imapCount');
  const graphCountEl = document.getElementById('graphCount');
  const totalCountEl = document.getElementById('totalCount');

  headerEl.classList.add('visible');

  const imapEmails = emails.filter(e => e.protocol === 'imap');
  const graphEmails = emails.filter(e => e.protocol === 'graph');
  const externalEmails = emails.filter(e => e.protocol !== 'imap' && e.protocol !== 'graph');
  const existingExternalCount = document.getElementById('externalCount');
  if (existingExternalCount) existingExternalCount.remove();

  imapCountEl.style.display = imapEmails.length > 0 ? 'inline' : 'none';
  graphCountEl.style.display = graphEmails.length > 0 ? 'inline' : 'none';
  imapCountEl.textContent = `IMAP: ${imapEmails.length}`;
  graphCountEl.textContent = `Graph: ${graphEmails.length}`;
  graphCountEl.insertAdjacentHTML('afterend', externalEmails.length > 0 ? `<span class="badge badge-external" id="externalCount">外部: ${externalEmails.length}</span>` : '');
  totalCountEl.textContent = `共 ${emails.length} 封`;

  if (emails.length === 0) {
    listEl.innerHTML = `<div class="empty-state">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.8"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7L12 13L2 7"/></svg>
      <p>未获取到邮件</p><p class="text-muted">请检查关键词或协议设置</p>
    </div>`;
    return;
  }

  let html = '';
  emails.forEach((email, index) => {
    const date = formatDate(email.date);
    const fromDisplay = email.fromName || email.from;
    const preview = (email.bodyPreview || email.bodyText || '').substring(0, 120);

    html += `<div class="email-card" style="animation-delay:${index * 0.04}s" onclick="showEmailDetail(${index})">
      <div class="email-card-header">
        <span class="email-from">${escapeHtml(fromDisplay)} <span class="email-protocol ${email.protocol}">${email.protocol}</span></span>
        <span class="email-date">${date}</span>
      </div>
      <div class="email-subject">${escapeHtml(email.subject)}</div>
      <div class="email-preview">${escapeHtml(preview)}</div>
      <div class="email-account-tag">📬 ${escapeHtml(email._account || '')}</div>
    </div>`;
  });

  listEl.innerHTML = html;
  window._currentEmails = emails;
}

function showEmailDetail(index) {
  const email = window._currentEmails?.[index];
  if (!email) return;

  document.getElementById('emailDetailSubject').textContent = email.subject;
  document.getElementById('emailDetailMeta').innerHTML = `
    <span><strong>发件人</strong> ${escapeHtml(email.fromName ? `${email.fromName} <${email.from}>` : email.from)}</span>
    <span><strong>时间</strong> ${formatDate(email.date, true)}</span>
    <span><strong>协议</strong> <span class="email-protocol ${email.protocol}">${email.protocol.toUpperCase()}</span></span>
    <span><strong>账号</strong> ${escapeHtml(email._account || '')}</span>
  `;

  const initialMode = email.protocol === 'qq-mail' ? 'clean' : 'body';
  renderEmailDetailBody(email, initialMode);

  document.getElementById('emailDetailModal').classList.add('active');
}

function renderEmailDetailBody(email, mode = 'body') {
  const bodyEl = document.getElementById('emailDetailBody');
  if (!bodyEl) return;

  const rawText = email.bodyText || email.bodyPreview || '';
  const rawHtml = email.bodyHtml || '';
  const clean = buildCleanEmailBody(email);
  const useRawView = mode === 'raw';
  const rawContent = rawText || stripHtmlForDisplay(rawHtml) || '(无内容)';
  const bodyContent = email.protocol === 'qq-mail'
    ? renderCleanEmailContent(clean)
    : renderOriginalEmailContent(email);

  bodyEl.innerHTML = `
    <div class="email-detail-toolbar">
      <div class="email-detail-tabs">
        <button class="email-detail-tab ${!useRawView ? 'active' : ''}" data-mode="body">正文</button>
        <button class="email-detail-tab ${useRawView ? 'active' : ''}" data-mode="raw">原文</button>
      </div>
      ${clean.code ? `<button class="email-code-copy" data-code="${escapeAttr(clean.code)}" title="复制验证码">复制验证码</button>` : ''}
    </div>
    <div class="email-detail-content">
      ${useRawView ? renderRawEmailContent(rawContent) : bodyContent}
    </div>
  `;

  bodyEl.querySelectorAll('.email-detail-tab').forEach(btn => {
    btn.addEventListener('click', () => renderEmailDetailBody(email, btn.dataset.mode));
  });
  bodyEl.querySelector('.email-code-copy')?.addEventListener('click', () => {
    copyText(clean.code, `已复制验证码 ${clean.code}`);
  });
}

function renderCleanEmailContent(clean) {
  if (!clean.text && !clean.code) {
    return '<div class="email-clean empty">(无内容)</div>';
  }

  return `<article class="email-clean">
    ${clean.code ? `<section class="email-code-panel">
      <span class="email-code-label">验证码</span>
      <strong class="email-code-value">${escapeHtml(clean.code)}</strong>
    </section>` : ''}
    <div class="email-clean-text">${formatCleanEmailText(clean.text || '')}</div>
  </article>`;
}

function renderRawEmailContent(rawContent) {
  return `<pre class="email-raw">${escapeHtml(rawContent || '(无内容)')}</pre>`;
}

function renderOriginalEmailContent(email) {
  if (email.bodyHtml) {
    return `<iframe class="email-html-frame" srcdoc="${escapeAttr(email.bodyHtml)}" sandbox="allow-same-origin"></iframe>`;
  }
  return renderCleanEmailContent(buildCleanEmailBody(email));
}

function buildCleanEmailBody(email) {
  const source = [
    email.bodyText,
    stripHtmlForDisplay(email.bodyHtml || ''),
    email.bodyPreview,
  ].filter(Boolean).join('\n');
  const decoded = decodeDisplayText(source);
  let text = stripHtmlForDisplay(decoded)
    .replace(/DuckDuckGo\s+removed\s+trackers\s+from\s+[^.]+\.?\s*More\s*Deactivate/gi, ' ')
    .replace(/\bDuckDuckGo\s+removed\s+trackers\s+from\s+[^.]+\.?\s*More\b/gi, ' ')
    .replace(/\bDeactivate\b/gi, ' ')
    .replace(/\bChatGPT\s+Help\s+center\b/gi, ' ')
    .replace(/\bHelp\s+center\b/gi, ' ')
    .replace(/\bChatGPT\s+ChatGPT\b/gi, 'ChatGPT')
    .replace(/\s+/g, ' ')
    .trim();

  const code = extractDisplayOtp(text);
  if (code) {
    const marker = text.search(/enter\s+this\s+temporary\s+verification\s+code\s+to\s+continue/i);
    if (marker >= 0) text = text.slice(marker);
  }

  return { text, code };
}

function decodeDisplayText(value = '') {
  return String(value || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtmlForDisplay(value = '') {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function extractDisplayOtp(text = '') {
  const patterns = [
    /enter\s+this\s+temporary\s+verification\s+code\s+to\s+continue(?:\D{0,80})(\d{6})/i,
    /(?:login\s+code|verification\s+code|temporary\s+code|one[-\s]?time\s+code)(?:\D{0,80})(\d{6})/i,
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) return match[1];
  }
  return '';
}

function formatCleanEmailText(text = '') {
  const normalized = String(text || '')
    .replace(/(Enter this temporary verification code to continue:?)\s*(\d{6})/i, '$1\n$2')
    .replace(/(Didn'?t request a verification code\?)/i, '\n$1')
    .replace(/(Best,\s*The ChatGPT team)/i, '\n$1')
    .trim();

  return escapeHtml(normalized).replace(/\n/g, '<br>');
}

// ==================== 辅助函数 ====================
function deduplicateEmails(emails) {
  const seen = new Map();
  emails.forEach(e => {
    const key = e.messageId || `${e.subject}-${e.date}`;
    if (!seen.has(key)) seen.set(key, e);
  });
  return Array.from(seen.values());
}

function showSkeletonCards(count) {
  const listEl = document.getElementById('emailList');
  let html = '';
  for (let i = 0; i < count; i++) html += '<div class="skeleton skeleton-card"></div>';
  listEl.innerHTML = html;
}

function renderFetchIssues(errors = []) {
  const issuesEl = document.getElementById('fetchIssues');
  if (!issuesEl) return;
  if (!errors.length) {
    issuesEl.style.display = 'none';
    issuesEl.innerHTML = '';
    return;
  }

  issuesEl.style.display = 'block';
  issuesEl.innerHTML = errors.map(item => {
    const protocol = item.protocol ? ` [${item.protocol}]` : '';
    return `<div class="fetch-issue-item">
      <strong>${escapeHtml(item.email || '邮箱')}${escapeHtml(protocol)}</strong>
      <span>${escapeHtml(item.error || '未知错误')}</span>
    </div>`;
  }).join('');
}

function showProgress(show) {
  document.getElementById('progressContainer').style.display = show ? 'block' : 'none';
}

function updateProgress(percent, text) {
  document.getElementById('progressFill').style.width = `${percent}%`;
  document.getElementById('progressText').textContent = text;
  document.getElementById('progressPercent').textContent = `${percent}%`;
}

// ==================== 事件绑定 ====================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnFetchSelected').addEventListener('click', async () => {
    const ids = getSelectedAccountIds();
    if (ids.length === 0) {
      showToast('请先在左侧勾选要取件的邮箱', 'warning');
      const sidebar = document.querySelector('.sidebar');
      sidebar.classList.add('sidebar-highlight');
      setTimeout(() => sidebar.classList.remove('sidebar-highlight'), 1500);
      return;
    }
    const fullAccounts = await loadFullAccounts();
    const selected = fullAccounts.filter(a => ids.includes(a.id));
    startFetch(selected);
  });

  document.getElementById('btnFetchAll').addEventListener('click', async () => {
    const fullAccounts = await loadFullAccounts();
    if (fullAccounts.length === 0) {
      showToast('请先导入邮箱', 'warning');
      return;
    }
    startFetch(fullAccounts);
  });
});

function startFetch(accounts) {
  const keyword = document.getElementById('searchKeyword').value.trim();
  const sender = document.getElementById('searchSender').value.trim();
  const limit = parseInt(document.getElementById('fetchLimit').value);

  const btnSelected = document.getElementById('btnFetchSelected');
  const btnAll = document.getElementById('btnFetchAll');
  btnSelected.disabled = true;
  btnAll.disabled = true;

  fetchEmails(accounts, { keyword, sender, limit }).finally(() => {
    btnSelected.disabled = false;
    btnAll.disabled = false;
  });
}
