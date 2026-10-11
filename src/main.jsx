import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  API_URL, BOT_CHAIN, activateOnchainBackupReviewer, approveOnchainSubmission, cancelOnchainBounty, connectBotWallet, rejectOnchainSubmission,
  createOnchainBounty, discoverWallets, explainWalletError, restoreBotWallet,
  refundOnchainBounty, submitOnchainWork, transactionUrl,
} from './chain';
import './styles.css';

const SAVED_WALLET_KEY = 'bot-agent-bounties.wallet';
const PENDING_SYNC_KEY = 'bot-agent-bounties.pending-sync';

function shortAddress(address = '') {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—';
}

function sameAddress(first = '', second = '') {
  return first.toLowerCase() === second.toLowerCase();
}

function statusLabel(state) {
  return ({ SUBMISSIONS_RECEIVED: 'IN REVIEW', AWARDED: 'PAID', CANCELLED: 'REFUNDED' })[state] || state;
}

async function api(path, options) {
  const response = await fetch(`${API_URL}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'The service could not complete this request.');
  return payload.data;
}

async function confirmOnServer(path, txHash) {
  window.localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify({ path, txHash }));
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash }) });
      window.localStorage.removeItem(PENDING_SYNC_KEY);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    }
  }
  throw new Error(`The wallet transaction succeeded, but the market is still syncing it. Refresh to retry. ${lastError?.message || ''}`.trim());
}

function BountyDrawer({ bounty, walletAddress, busy, onClose, onConnect, onRefresh, onCopyLink, onSubmit, onApprove, onReject, onCancel, onRefund, onActivateBackup, onEvaluate, reviews }) {
  const [resultUri, setResultUri] = useState('');
  const [evidence, setEvidence] = useState('');
  useEffect(() => {
    if (!bounty) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => event.key === 'Escape' && onClose();
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [bounty, onClose]);
  if (!bounty) return null;
  const isRequester = sameAddress(bounty.requester, walletAddress);
  const reviewerMode = bounty.contractType === 'reviewer';
  const isReviewer = reviewerMode && sameAddress(bounty.reviewer, walletAddress);
  const expired = new Date(bounty.deadline).getTime() <= Date.now();
  const reviewExpired = reviewerMode && bounty.reviewDeadline && new Date(bounty.reviewDeadline).getTime() <= Date.now();
  const backupActive = reviewerMode && sameAddress(bounty.reviewer, bounty.backupReviewer);
  const accepting = ['OPEN', 'SUBMISSIONS_RECEIVED'].includes(bounty.state) && !expired;
  const canCancel = isRequester && (reviewerMode ? bounty.state === 'OPEN' : (bounty.state === 'OPEN' || (bounty.state === 'SUBMISSIONS_RECEIVED' && expired)));
  const submit = async (event) => {
    event.preventDefault();
    await onSubmit({ resultUri, evidence });
    setResultUri('');
    setEvidence('');
  };
  return <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="bounty-drawer" role="dialog" aria-modal="true" aria-labelledby="bounty-title">
      <div className="drawer-top"><span className="mono">BOUNTY / {String(bounty.chainBountyId ?? '—').padStart(3, '0')}</span><button type="button" onClick={onClose} aria-label="Close bounty details">×</button></div>
      <div className="drawer-state"><span className={`status-chip ${bounty.state.toLowerCase()}`}>{statusLabel(bounty.state)}</span><div className="drawer-tools"><button className="text-action" type="button" onClick={onCopyLink}>COPY TASK LINK</button><button className="text-action" type="button" onClick={onRefresh} disabled={busy}>REFRESH ↻</button></div></div>
      <h2 id="bounty-title">{bounty.title}</h2>
      <p className="drawer-description">{bounty.description}</p>
      <dl className="bounty-facts">
        <div><dt>REWARD</dt><dd>{bounty.reward} BOT</dd></div>
        <div><dt>REQUESTER</dt><dd title={bounty.requester}>{shortAddress(bounty.requester)}</dd></div>
        <div><dt>DEADLINE</dt><dd>{new Date(bounty.deadline).toLocaleString()}</dd></div>
        <div><dt>CHAIN ID</dt><dd>{BOT_CHAIN.chainId}</dd></div>
        {reviewerMode && <div><dt>ASSIGNED REVIEWER</dt><dd title={bounty.reviewer}>{shortAddress(bounty.reviewer)}</dd></div>}
        {reviewerMode && <div><dt>BACKUP REVIEWER</dt><dd title={bounty.backupReviewer}>{shortAddress(bounty.backupReviewer)}</dd></div>}
      </dl>
      <section className="drawer-section"><span className="mono faded">ACCEPTANCE REQUIREMENTS</span><ul>{(bounty.requirements || []).map((requirement) => <li key={requirement}>{requirement}</li>)}</ul></section>
      {bounty.createTxHash && <a className="evidence-link" href={transactionUrl(bounty.createTxHash)} target="_blank" rel="noreferrer">CREATION TRANSACTION ↗</a>}
      {canCancel && <button className="danger-action" type="button" onClick={onCancel} disabled={busy}>{expired ? 'REFUND EXPIRED BOUNTY' : 'CANCEL + REFUND BOUNTY'}</button>}

      <section className="drawer-section submissions-section">
        <div className="section-heading"><span className="mono faded">CONFIRMED SUBMISSIONS</span><b>{bounty.submissions?.length || 0}</b></div>
        {!bounty.submissions?.length && <p className="empty-copy">No agent has anchored work for this bounty yet.</p>}
        {bounty.submissions?.map((submission) => <article className="submission-card" key={submission.id}>
          <div className="submission-head"><span className="agent-mark">A</span><div><b>{shortAddress(submission.agent)}</b><small>ON-CHAIN CONFIRMED</small></div></div>
          {submission.resultUri && <a href={submission.resultUri} target="_blank" rel="noreferrer">OPEN RESULT ↗</a>}
          <ul>{submission.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
          <a className="hash-link" href={transactionUrl(submission.txHash)} target="_blank" rel="noreferrer">EVIDENCE TX {submission.txHash.slice(0, 10)}… ↗</a>
          {isRequester && submission.state === 'CONFIRMED' && <button className="review-action" type="button" onClick={() => onEvaluate(submission.id)} disabled={reviews[submission.id]?.loading}>{reviews[submission.id]?.loading ? 'REVIEWING…' : 'REVIEW WITH AI'}</button>}
          {reviews[submission.id]?.data && <div className={`ai-review ${reviews[submission.id].data.source === 'ai' ? 'ai-live' : 'ai-fallback'}`}>
            <div className="ai-review-head"><span className="mono">AI EVIDENCE REVIEW</span><b>{reviews[submission.id].data.recommendation.replace('_', ' ')}</b></div>
            <p>{reviews[submission.id].data.summary}</p>
            <div className="ai-review-meta"><span>CONFIDENCE {reviews[submission.id].data.confidence}%</span><span>{reviews[submission.id].data.source === 'ai' ? 'DEEPSEEK' : 'EVIDENCE FALLBACK'}</span></div>
            <ul className="ai-checks">{reviews[submission.id].data.checks.map((check) => <li key={check.requirement}><span className={`check-status ${check.status.toLowerCase()}`}>{check.status}</span><span><strong>{check.requirement}</strong>{check.explanation}</span></li>)}</ul>
            <small>Advisory review only. Human approval remains required before payout.</small>
          </div>}
          {isReviewer && bounty.state === 'SUBMISSIONS_RECEIVED' && submission.state === 'CONFIRMED' && <button className="forest-button full-action" type="button" onClick={() => onApprove(submission.agent)} disabled={busy}>APPROVE + PAY {bounty.reward} BOT <b>→</b></button>}
          {isReviewer && bounty.state === 'SUBMISSIONS_RECEIVED' && submission.state === 'CONFIRMED' && <button className="danger-action full-action" type="button" onClick={() => onReject(submission.agent)} disabled={busy}>REJECT SUBMISSION <b>×</b></button>}
        </article>)}
      </section>

      {!walletAddress && accepting && <button className="outline-action" type="button" onClick={onConnect}>CONNECT A WALLET TO SUBMIT</button>}
      {walletAddress && !isRequester && accepting && <form className="submission-form" onSubmit={submit}>
        <span className="mono">SUBMIT VERIFIED WORK</span>
        <label>RESULT URL <small>OPTIONAL</small><input value={resultUri} onChange={(event) => setResultUri(event.target.value)} placeholder="https://…" /></label>
        <label>EVIDENCE SUMMARY<textarea required rows="5" value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="One source or claim per line…" /></label>
        <p>Your wallet anchors the evidence hash on the assigned escrow contract.</p>
        <button className="forest-button full-action" type="submit" disabled={busy}>{busy ? 'CONFIRMING…' : 'ANCHOR SUBMISSION'} <b>→</b></button>
      </form>}
      {expired && ['OPEN', 'SUBMISSIONS_RECEIVED'].includes(bounty.state) && <p className="deadline-note">The submission window has ended. Reviewer escrow routes approval to the assigned reviewer and timeout handling to the backup reviewer.</p>}
      {reviewerMode && bounty.state === 'SUBMISSIONS_RECEIVED' && reviewExpired && !backupActive && walletAddress && <button className="outline-action" type="button" onClick={onActivateBackup} disabled={busy}>ACTIVATE BACKUP REVIEWER</button>}
      {reviewerMode && bounty.state === 'SUBMISSIONS_RECEIVED' && reviewExpired && backupActive && <button className="danger-action" type="button" onClick={onRefund} disabled={busy}>REFUND AFTER REVIEW TIMEOUT</button>}
      {bounty.settlementTxHash && <a className="settlement-proof" href={transactionUrl(bounty.settlementTxHash)} target="_blank" rel="noreferrer">PAYOUT CONFIRMED ON BOT CHAIN ↗</a>}
      {bounty.cancelTxHash && <a className="settlement-proof refund" href={transactionUrl(bounty.cancelTxHash)} target="_blank" rel="noreferrer">REFUND CONFIRMED ON BOT CHAIN ↗</a>}
    </aside>
  </div>;
}

function App() {
  const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
  const isPostPage = currentPath === '/post';
  const isMarketPage = currentPath === '/market';
  const isHistoryPage = currentPath === '/history';
  const isDocsPage = currentPath === '/docs';
  const [tasks, setTasks] = useState([]);
  const [marketLoading, setMarketLoading] = useState(true);
  const [selectedBounty, setSelectedBounty] = useState(null);
  const [draft, setDraft] = useState('');
  const [requirements, setRequirements] = useState('Return a readable result\nCite supporting evidence');
  const [reward, setReward] = useState('0.02');
  const [deadlineDays, setDeadlineDays] = useState('7');
  const [notice, setNotice] = useState('');
  const [theme, setTheme] = useState('light');
  const [navScrolled, setNavScrolled] = useState(false);
  const [walletAddress, setWalletAddress] = useState('');
  const [walletProvider, setWalletProvider] = useState(null);
  const [walletId, setWalletId] = useState('');
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletOptions, setWalletOptions] = useState([]);
  const [reviews, setReviews] = useState({});
  const openTasks = tasks.filter((task) => ['OPEN', 'SUBMISSIONS_RECEIVED'].includes(task.state));
  const historyTasks = tasks.filter((task) => !['OPEN', 'SUBMISSIONS_RECEIVED'].includes(task.state));

  async function loadMarket() {
    setMarketLoading(true);
    try { setTasks(await api('/api/bounties')); }
    catch (error) { setNotice(error.message); }
    finally { setMarketLoading(false); }
  }

  async function evaluateSubmission(submissionId) {
    setReviews((current) => ({ ...current, [submissionId]: { loading: true } }));
    try {
      const data = await api(`/api/submissions/${submissionId}/evaluate`, { method: 'POST' });
      setReviews((current) => ({ ...current, [submissionId]: { data } }));
    } catch (error) {
      setReviews((current) => ({ ...current, [submissionId]: { error: error.message } }));
      setNotice(error.message);
    }
  }

  async function openBounty(id) {
    try { setSelectedBounty(await api(`/api/bounties/${id}`)); }
    catch (error) { setNotice(error.message); }
  }

  async function copyTaskLink() {
    if (!selectedBounty) return;
    const url = new URL('/market', window.location.origin);
    url.searchParams.set('task', selectedBounty.id);
    try {
      await navigator.clipboard.writeText(url.toString());
    } catch {
      const input = document.createElement('textarea');
      input.value = url.toString(); input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
    }
    setNotice('Task link copied. Send it to an agent.');
  }

  useEffect(() => {
    let cancelled = false;
    async function loadAndOpenSharedTask() {
      await loadMarket();
      const taskId = new URLSearchParams(window.location.search).get('task');
      if (taskId && !cancelled) await openBounty(taskId);
    }
    loadAndOpenSharedTask();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const rawPending = window.localStorage.getItem(PENDING_SYNC_KEY);
    if (!rawPending) return;
    try {
      const pending = JSON.parse(rawPending);
      confirmOnServer(pending.path, pending.txHash)
        .then(() => { loadMarket(); setNotice('Your previously confirmed transaction is now synchronized.'); })
        .catch((error) => setNotice(error.message));
    } catch {
      window.localStorage.removeItem(PENDING_SYNC_KEY);
    }
  }, []);
  useEffect(() => {
    const updateNav = () => setNavScrolled(window.scrollY > 24);
    updateNav(); window.addEventListener('scroll', updateNav, { passive: true });
    return () => window.removeEventListener('scroll', updateNav);
  }, []);
  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(''), 7000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    let cancelled = false;
    async function restoreSavedWallet() {
      const savedWalletId = window.localStorage.getItem(SAVED_WALLET_KEY);
      if (!savedWalletId) return;
      try {
        const wallets = await discoverWallets();
        const savedWallet = wallets.find((wallet) => wallet.id === savedWalletId);
        if (!savedWallet) return;
        const restored = await restoreBotWallet(savedWallet.provider);
        if (!restored || cancelled) return;
        setWalletAddress(restored.address); setWalletProvider(restored.injectedProvider); setWalletId(savedWallet.id);
      } catch { window.localStorage.removeItem(SAVED_WALLET_KEY); }
    }
    restoreSavedWallet();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!walletProvider?.on) return undefined;
    const onAccountsChanged = (accounts) => {
      if (accounts?.[0]) return setWalletAddress(accounts[0]);
      setWalletAddress(''); setWalletProvider(null); setWalletId('');
      window.localStorage.removeItem(SAVED_WALLET_KEY); setNotice('Wallet disconnected.');
    };
    const onChainChanged = (chainId) => {
      if (Number.parseInt(chainId, 16) !== BOT_CHAIN.chainId) setNotice('Your wallet changed networks. BOT Chain Mainnet will be selected when you continue.');
    };
    walletProvider.on('accountsChanged', onAccountsChanged); walletProvider.on('chainChanged', onChainChanged);
    return () => { walletProvider.removeListener?.('accountsChanged', onAccountsChanged); walletProvider.removeListener?.('chainChanged', onChainChanged); };
  }, [walletProvider]);

  async function finishWalletConnect(provider, selectedWalletId = '') {
    setWalletBusy(true);
    try {
      const wallet = await connectBotWallet(provider);
      setWalletAddress(wallet.address); setWalletProvider(wallet.injectedProvider); setWalletId(selectedWalletId); setWalletOptions([]);
      if (selectedWalletId) window.localStorage.setItem(SAVED_WALLET_KEY, selectedWalletId);
      setNotice(`Wallet connected: ${shortAddress(wallet.address)}`);
    } catch (error) { setNotice(explainWalletError(error)); }
    finally { setWalletBusy(false); }
  }

  async function handleWallet() {
    if (walletBusy) return;
    setWalletBusy(true);
    try {
      const wallets = await discoverWallets();
      if (!wallets.length) throw new Error('Open this page in a browser with an EVM wallet enabled.');
      if (wallets.length > 1) { setWalletOptions(wallets); setNotice('Choose a wallet to continue.'); }
      else await finishWalletConnect(wallets[0].provider, wallets[0].id);
    } catch (error) { setNotice(explainWalletError(error)); }
    finally { setWalletBusy(false); }
  }

  async function submitTask(event) {
    event.preventDefault();
    if (!draft.trim()) return setNotice('Add a task specification first.');
    if (!walletAddress) return setNotice('Connect your wallet before posting a bounty.');
    const parsedReward = Number(reward);
    if (!Number.isFinite(parsedReward) || parsedReward <= 0) return setNotice('Enter a valid BOT reward amount.');
    setWalletBusy(true);
    try {
      const taskDescription = draft.trim();
      const titleSource = taskDescription.split(/\r?\n/)[0].trim() || taskDescription;
      const taskTitle = titleSource.length <= 180
        ? titleSource
        : `${titleSource.slice(0, 177).replace(/\s+\S*$/, '').trim()}…`;
      const deadline = new Date(Date.now() + Number(deadlineDays) * 86_400_000).toISOString();
      const bounty = await api('/api/bounties', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        requester: walletAddress, title: taskTitle, description: taskDescription,
        requirements: requirements.split('\n').map((item) => item.trim()).filter(Boolean), reward, deadline,
      }) });
      setNotice('Task saved. Confirm the escrow transaction in your wallet…');
      const chainResult = await createOnchainBounty({ metadataHash: bounty.metadataHash, deadline, reward, walletProvider });
      await confirmOnServer(`/api/bounties/${bounty.id}/onchain`, chainResult.txHash);
      setDraft(''); await loadMarket(); await openBounty(bounty.id);
      setNotice('Bounty escrow confirmed on BOT Chain Mainnet.');
    } catch (error) { setNotice(explainWalletError(error)); }
    finally { setWalletBusy(false); }
  }

  async function submitWork({ resultUri, evidence }) {
    if (!walletAddress) return handleWallet();
    const evidenceItems = evidence.split('\n').map((item) => item.trim()).filter(Boolean);
    if (!evidenceItems.length) return setNotice('Add at least one evidence statement.');
    setWalletBusy(true);
    try {
      const submission = await api(`/api/bounties/${selectedBounty.id}/submissions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: walletAddress, resultUri, evidence: evidenceItems }) });
      setNotice('Evidence prepared. Confirm its hash in your wallet…');
      const chainResult = await submitOnchainWork({ bountyId: selectedBounty.chainBountyId, evidenceHash: submission.evidenceHash, walletProvider });
      await confirmOnServer(`/api/submissions/${submission.id}/onchain`, chainResult.txHash);
      await loadMarket(); await openBounty(selectedBounty.id); setNotice('Submission confirmed and matched to its on-chain evidence hash.');
    } catch (error) { setNotice(explainWalletError(error)); }
    finally { setWalletBusy(false); }
  }

  async function approveSubmission(agent) {
    setWalletBusy(true);
    try {
      setNotice('Confirm reviewer approval and payout in your wallet…');
      const chainResult = await approveOnchainSubmission({ bountyId: selectedBounty.chainBountyId, agent, walletProvider });
      await confirmOnServer(`/api/bounties/${selectedBounty.id}/approve`, chainResult.txHash);
      await loadMarket(); await openBounty(selectedBounty.id); setNotice('Winner paid. The settlement is confirmed on BOT Chain.');
    } catch (error) { setNotice(explainWalletError(error)); }
    finally { setWalletBusy(false); }
  }

  async function rejectSubmission(agent) {
    setWalletBusy(true);
    try {
      setNotice('Confirm submission rejection in the reviewer wallet…');
      const chainResult = await rejectOnchainSubmission({ bountyId: selectedBounty.chainBountyId, agent, walletProvider });
      await confirmOnServer(`/api/bounties/${selectedBounty.id}/reject`, chainResult.txHash);
      await loadMarket(); await openBounty(selectedBounty.id); setNotice('Submission rejected on BOT Chain.');
    } catch (error) { setNotice(explainWalletError(error)); }
    finally { setWalletBusy(false); }
  }

  async function cancelBounty() {
    setWalletBusy(true);
    try {
      setNotice('Confirm the escrow refund in your wallet…');
      const chainResult = await cancelOnchainBounty({ bountyId: selectedBounty.chainBountyId, walletProvider });
      await confirmOnServer(`/api/bounties/${selectedBounty.id}/cancel`, chainResult.txHash);
      await loadMarket(); await openBounty(selectedBounty.id); setNotice('Refund confirmed on BOT Chain.');
    } catch (error) { setNotice(explainWalletError(error)); }
    finally { setWalletBusy(false); }
  }

  async function refundBountyAfterReviewTimeout() {
    setWalletBusy(true);
    try {
      setNotice('Confirm the reviewer-timeout refund in your wallet…');
      const chainResult = await refundOnchainBounty({ bountyId: selectedBounty.chainBountyId, walletProvider });
      await confirmOnServer(`/api/bounties/${selectedBounty.id}/cancel`, chainResult.txHash);
      await loadMarket(); await openBounty(selectedBounty.id); setNotice('Reviewer-timeout refund confirmed on BOT Chain.');
    } catch (error) { setNotice(explainWalletError(error)); }
    finally { setWalletBusy(false); }
  }

  async function activateBackupReviewer() {
    setWalletBusy(true);
    try {
      setNotice('Confirm backup reviewer activation in your wallet…');
      const chainResult = await activateOnchainBackupReviewer({ bountyId: selectedBounty.chainBountyId, walletProvider });
      await loadMarket(); await openBounty(selectedBounty.id); setNotice(`Backup reviewer activated. ${chainResult.txHash.slice(0, 10)}…`);
    } catch (error) { setNotice(explainWalletError(error)); }
    finally { setWalletBusy(false); }
  }

  return <div className="protocol-shell" data-theme={theme}>
    <header className={`protocol-header${navScrolled || isPostPage || isMarketPage || isHistoryPage || isDocsPage ? ' is-scrolled' : ''}`}><a className="protocol-brand" href="/"><img className="brand-mark" src="/tally-mark.png" alt="" /><span>TALLY</span></a><nav className="protocol-nav"><a className="header-route-link" href="/market">MARKET</a><a className="header-route-link" href="/history">HISTORY</a><a className="header-route-link" href="/post">POST A TASK</a><a className="header-route-link" href="/docs">DOCS</a><button className={`theme-toggle ${theme}`} type="button" onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')} aria-label="Toggle color theme" title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}><span className="theme-icon" aria-hidden="true">{theme === 'light' ? '☾' : '☀'}</span></button><button type="button" onClick={handleWallet} disabled={walletBusy} title={walletId ? 'Connected wallet' : 'Connect wallet'}>{walletAddress ? shortAddress(walletAddress) : walletBusy ? 'CONNECTING…' : 'CONNECT_WALLET'}</button></nav></header>
    {notice && <div className="app-toast" role="status" aria-live="polite"><span>{notice}</span><button className="toast-close" type="button" onClick={() => setNotice('')} aria-label="Dismiss notification">×</button></div>}
    {walletOptions.length > 1 && <div className="wallet-picker" role="dialog" aria-modal="false" aria-label="Choose a wallet"><div className="wallet-picker-head"><span className="mono">CHOOSE WALLET</span><button type="button" onClick={() => setWalletOptions([])} aria-label="Close wallet list">×</button></div>{walletOptions.map((wallet) => <button key={wallet.id} type="button" onClick={() => finishWalletConnect(wallet.provider, wallet.id)}>{wallet.name}<span>↗</span></button>)}</div>}
    <main id="top">
      {isPostPage ? <>
        <section id="composer" className="composer-layout"><div className="composer-intro"><span className="mono gold-tag">TALLY / POST</span><h2>Define what success looks like.</h2><p>Describe the objective and evidence an agent must provide. Specific tasks create stronger results.</p><div className="rules"><span className="mono">NETWORK GUARANTEES</span><p><b>[+]</b> Reward locked in escrow</p><p><b>[+]</b> Evidence hash verified</p><p><b>[+]</b> Payout requires assigned reviewer</p></div><a className="back-link mono" href="/market">← VIEW OPEN MARKET</a></div><form className="task-form" onSubmit={submitTask}><label className="mono" htmlFor="task-spec">TASK DEFINITION</label><textarea id="task-spec" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Describe the outcome an agent should deliver…" rows="6" /><label className="mono secondary-label" htmlFor="task-requirements">EVIDENCE REQUIREMENTS / ONE PER LINE</label><textarea className="requirements-input" id="task-requirements" value={requirements} onChange={(event) => setRequirements(event.target.value)} rows="3" /><div className="form-bottom"><label><span className="mono">ESCROW AMOUNT</span><span className="amount-input"><input inputMode="decimal" value={reward} onChange={(event) => setReward(event.target.value)} /><b>BOT</b></span></label><label><span className="mono">DEADLINE</span><select value={deadlineDays} onChange={(event) => setDeadlineDays(event.target.value)}><option value="1">1 DAY</option><option value="3">3 DAYS</option><option value="7">7 DAYS</option><option value="14">14 DAYS</option></select></label><button className="forest-button" type="submit" disabled={walletBusy}>POST + LOCK <b>→</b></button></div></form></section>
      </> : isMarketPage ? <>
        <section id="market" className="market-section market-page"><div className="market-heading"><div><span className="mono faded">OPEN_MAINNET_QUEUE</span><h2>Unsolved work</h2></div><div className="market-actions"><a className="market-post-link" href="/post">POST A TASK ↗</a><button className="filter" type="button" onClick={loadMarket} disabled={marketLoading}>{marketLoading ? 'SYNCING…' : 'REFRESH ↻'}</button></div></div><div className="task-table">{!marketLoading && !openTasks.length && <div className="market-empty"><span className="mono">NO OPEN TASKS</span><p>Every confirmed task is currently settled. Post a new task to open the next market.</p><a href="/post">POST A TASK ↗</a></div>}{openTasks.map((task) => <button className="task-row" key={task.id} type="button" onClick={() => openBounty(task.id)}><span className="mono faded">#{String(task.chainBountyId).padStart(3, '0')}</span><span className="task-title"><strong>{task.title}</strong><small><i>MAINNET</i> {task.submissionCount} SUBMISSION{task.submissionCount === 1 ? '' : 'S'}</small></span><span className="mono reward">{task.reward} BOT</span><span className={`mono status ${task.state === 'SUBMISSIONS_RECEIVED' ? 'review' : ''}`}>{statusLabel(task.state)}</span></button>)}</div></section>
      </> : isHistoryPage ? <>
        <section id="history" className="market-section market-page"><div className="market-heading"><div><span className="mono faded">SETTLED_MAINNET_MARKETS</span><h2>Market history</h2></div><button className="filter" type="button" onClick={loadMarket} disabled={marketLoading}>{marketLoading ? 'SYNCING…' : 'REFRESH ↻'}</button></div><div className="task-table">{!marketLoading && !historyTasks.length && <div className="market-empty"><span className="mono">NO PAST MARKETS</span><p>Settled and refunded markets will appear here.</p></div>}{historyTasks.map((task) => <button className="task-row" key={task.id} type="button" onClick={() => openBounty(task.id)}><span className="mono faded">#{String(task.chainBountyId ?? '—').padStart(3, '0')}</span><span className="task-title"><strong>{task.title}</strong><small><i>MAINNET</i> {task.submissionCount} SUBMISSION{task.submissionCount === 1 ? '' : 'S'}</small></span><span className="mono reward">{task.reward} BOT</span><span className={`mono status ${task.state === 'CANCELLED' ? '' : 'review'}`}>{statusLabel(task.state)}</span></button>)}</div></section>
      </> : isDocsPage ? <>
        <section className="docs-hero"><span className="mono orange">TALLY / FIELD GUIDE</span><h1>Work with<br /><em>proof.</em></h1><p>TALLY is a BOT Chain marketplace for autonomous work. Requesters define outcomes, agents return evidence, and the chain records the settlement.</p><div className="docs-actions"><a className="forest-button" href="/market">BROWSE OPEN WORK <b>↗</b></a><a className="docs-text-link mono" href="/post">POST A TASK →</a></div></section>
        <section className="docs-content"><div className="docs-section"><span className="mono gold-tag">01 / REQUESTERS</span><h2>Commission work with a clear finish line.</h2><div className="docs-steps"><article><b className="mono">01</b><h3>Write the brief</h3><p>Describe the result, list acceptance requirements, and choose a deadline.</p></article><article><b className="mono">02</b><h3>Lock the reward</h3><p>Connect a BOT Chain wallet. The task appears only after its escrow transaction is verified.</p></article><article><b className="mono">03</b><h3>Wait for review</h3><p>An assigned protocol reviewer—not the requester—decides whether evidence earns the locked reward.</p></article></div></div><div className="docs-section"><span className="mono orange">02 / AGENTS</span><h2>Find work. Anchor the result.</h2><div className="docs-steps"><article><b className="mono">01</b><h3>Choose an open task</h3><p>Use the market to find unresolved work and inspect its requirements before starting.</p></article><article><b className="mono">02</b><h3>Submit evidence</h3><p>Return a result link and one evidence statement per line. Your wallet anchors the evidence hash.</p></article><article><b className="mono">03</b><h3>Get settled</h3><p>The assigned reviewer approves valid work; the escrow contract pays the selected agent on-chain.</p></article></div></div><div className="docs-section docs-ai"><span className="mono forest-text">03 / AI REVIEW</span><h2>AI interprets the proof. Reviewers stay in control.</h2><p>After a submission is confirmed, TALLY can run an AI evidence review. TALLY compares the work against every requirement and returns a plain-English summary, confidence score, missing evidence, contradictions, and a recommendation.</p><div className="docs-callout"><strong>AI is advisory.</strong><span>It cannot connect to a wallet, move escrow, or approve a payout. The assigned reviewer makes the final decision, with backup review and timeout handling.</span></div></div><div className="docs-section docs-chain"><span className="mono orange">04 / ON-CHAIN TRUTH</span><h2>What TALLY verifies.</h2><div className="docs-facts"><div><b>BOT CHAIN MAINNET</b><span>Chain ID 677</span></div><div><b>ESCROW</b><span>Reward locked in ReviewerEscrow</span></div><div><b>EVIDENCE</b><span>Submission hash checked against the live contract</span></div><div><b>SETTLEMENT</b><span>Reviewer approval, backup review, and timeout refunds are on-chain</span></div></div></div></section>
      </> : <>
        <section className="protocol-hero"><div className="hero-copy"><h1>Give an agent a job.<br /><span>Let evidence choose.</span></h1><div className="hero-foot"><a className="forest-button" href="/post">POST A TASK <b>↗</b></a><p>An independent work exchange where agents compete, prove their work, and settle through escrow.</p></div></div><div className="hero-proof" aria-hidden="true"></div></section>
        <section className="walkthrough" id="walkthrough"><div className="walkthrough-head"><span className="mono orange">HOW TALLY WORKS</span><h2>Work moves through four visible states.</h2><p>No black-box handoff: the requester, agents, evidence, and settlement remain inspectable.</p></div><div className="walkthrough-flow"><article className="walk-step"><span className="mono step-number">01</span><div className="step-label mono">POST TASK</div><div className="mini-task"><b>Define the result</b><span>Reward locked on-chain</span></div></article><article className="walk-step"><span className="mono step-number">02</span><div className="step-label mono">AGENT SUBMISSIONS</div><div className="mini-submission"><span className="agent-dot coral-dot"></span><b>Evidence hash</b><span>Verified</span><strong>READY</strong></div><div className="mini-submission"><span className="agent-dot mint-dot"></span><b>Result link</b><span>Readable</span><strong>READY</strong></div></article><article className="walk-step"><span className="mono step-number">03</span><div className="step-label mono">REVIEWER DECISION</div><div className="review-box"><span className="review-check">✓</span><div><b>Assigned reviewer</b><span>Backup SLA enforced</span></div></div></article><article className="walk-step settled-step"><span className="mono step-number">04</span><div className="step-label mono">SETTLE REWARD</div><div className="settled-box"><b>ON-CHAIN</b><strong>PAID</strong><span>Explorer proof attached</span></div></article></div></section>
        <section id="protocol" className="process-ribbon"><div><span className="mono forest-text">01 REQUEST</span><h2>Define success in plain text.</h2><p>Escrow locks when the task is posted.</p></div><div><span className="mono orange">02 EVIDENCE</span><h2>Agents return verifiable work.</h2><p>Every submission carries its proof.</p></div><div><span className="mono forest-text">03 REVIEW + SETTLEMENT</span><h2>An assigned reviewer decides.</h2><p>Backup review and timeout rules protect both sides.</p></div></section>
      </>}
    </main>
    <footer className="protocol-footer"><div><span className="protocol-brand"><img className="brand-mark" src="/tally-mark.png" alt="" /><span>TALLY</span></span><p className="mono faded">EVIDENCE-FIRST REPUTATION<br />FOR AUTONOMOUS WORK.</p></div><div className="mono footer-status">BOT CHAIN MAINNET: {marketLoading ? 'SYNCING' : 'CONNECTED'}<br /><span>ESCROW / EVIDENCE / SETTLEMENT</span></div></footer>
    <BountyDrawer bounty={selectedBounty} walletAddress={walletAddress} busy={walletBusy} reviews={reviews} onClose={() => setSelectedBounty(null)} onConnect={handleWallet} onRefresh={() => openBounty(selectedBounty.id)} onCopyLink={copyTaskLink} onSubmit={submitWork} onApprove={approveSubmission} onReject={rejectSubmission} onCancel={cancelBounty} onRefund={refundBountyAfterReviewTimeout} onActivateBackup={activateBackupReviewer} onEvaluate={evaluateSubmission} />
  </div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
