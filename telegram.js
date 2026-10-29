// Telegram: the game messages residents when a decision needs a human (big spending, printing money, tax changes,
// citizens rejecting a proposal, a fix that didn't work), and they can grade the proposal A-F right from the chat.
// A player links their chat with /telegram in the game (a one-time code). Off unless TELEGRAM_BOT_TOKEN is set.
// At most PINGS_PER_DAY messages per person; each one says what happens if they don't answer.
const PINGS_PER_DAY = Number(process.env.TELEGRAM_PINGS_PER_DAY || 3);

export function startTelegram({ token, world, onGrade, saveWorldSoon, log = console.log }) {
  const T = (world.telegram ||= { links: {}, codes: {}, pings: {} });
  if (!token) return { enabled: false, linkCode: () => ({ ok: false, msg: 'Telegram is not set up on this server (TELEGRAM_BOT_TOKEN).' }), notify: () => 0 };
  const api = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()).catch((e) => ({ ok: false, description: e.message }));
  let bot = null, offset = 0, stopped = false;
  api('getMe').then((r) => { bot = r.result?.username || null; log(`[telegram] ${bot ? `@${bot} ready` : `not ready: ${r.description}`}`); });
  const send = (chat, text, buttons) => api('sendMessage', { chat_id: chat, text: text.slice(0, 3900), disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });
  const gradeButtons = (id) => [['A', 'B', 'C', 'D', 'E', 'F'].map((g) => ({ text: g, callback_data: `g:${id}:${g}` }))];
  function link(chat, code, from) {
    const c = T.codes[String(code || '').trim().toUpperCase()];
    if (!c || Date.now() > c.exp) return send(chat, 'That code is unknown or expired. In the game, type /telegram to get a new one.');
    delete T.codes[String(code).trim().toUpperCase()];
    T.links[c.playerId] = { chat, name: c.name, tg: from?.username || null, t: Date.now() }; saveWorldSoon();
    return send(chat, `Linked to ${c.name} in PromptCraft. I'll message you (at most ${PINGS_PER_DAY} times a day) when Edge Goa needs a human decision, and you can grade proposals here. Send /stop to unlink.`);
  }
  async function poll() {
    while (!stopped) {
      const r = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      if (!r.ok) { await new Promise((res) => setTimeout(res, 10e3)); continue; }
      for (const u of r.result) {
        offset = u.update_id + 1;
        try {
          const m = u.message, q = u.callback_query;
          if (m?.text) {
            const [cmd, arg] = m.text.trim().split(/\s+/);
            if (cmd === '/start' && arg) await link(m.chat.id, arg, m.from);
            else if (cmd === '/stop') { for (const [k, v] of Object.entries(T.links)) if (v.chat === m.chat.id) delete T.links[k]; saveWorldSoon(); await send(m.chat.id, 'Unlinked. Type /telegram in the game to link again.'); }
            else if (/^PC-?[A-Z0-9]{4,8}$/i.test(cmd)) await link(m.chat.id, cmd, m.from);
            else await send(m.chat.id, 'Type /telegram in PromptCraft to get a code, then send it here.');
          } else if (q?.data?.startsWith('g:')) {
            const [, id, g] = q.data.split(':'), who = Object.entries(T.links).find(([, v]) => v.chat === q.message?.chat?.id);
            const res = who ? onGrade(who[0], who[1].name, +id, g) : { ok: false, msg: 'This chat is not linked to a player.' };
            await api('answerCallbackQuery', { callback_query_id: q.id, text: String(res.msg || '').slice(0, 190) });
          }
        } catch (e) { log('[telegram] ' + e.message); }
      }
    }
  }
  poll();
  return {
    enabled: true,
    linkCode(playerId, name) {
      const code = 'PC' + Math.random().toString(36).slice(2, 8).toUpperCase();
      T.codes[code] = { playerId, name, exp: Date.now() + 15 * 60e3 }; saveWorldSoon();
      return { ok: true, msg: bot ? `Open https://t.me/${bot}?start=${code} (or send ${code} to @${bot}) within 15 minutes to get Edge Goa's alerts on Telegram.` : `Send ${code} to the game's Telegram bot within 15 minutes.` };
    },
    notify({ text, proposal = null, to = null }) { // -> how many people were messaged
      const day = Date.now() - 864e5; let n = 0;
      for (const [pid, l] of Object.entries(T.links)) {
        if (to && !to.includes(pid)) continue;
        const sent = (T.pings[pid] || []).filter((t) => t > day); if (sent.length >= PINGS_PER_DAY) continue;
        T.pings[pid] = [...sent, Date.now()]; n++;
        const deflt = proposal?.status === 'voting' ? `\nIf you don't answer: ${proposal.rule === 'consent' ? 'it passes unless a majority objects' : 'it is decided by whoever votes'}, at ${new Date(proposal.closes).toISOString().slice(11, 16)} UTC.` : '';
        send(l.chat, `🏛 Edge Goa needs you\n${text}${proposal?.predicted ? `\nWhat it does: ${proposal.predicted}` : ''}${proposal?.citizens ? `\nCitizens' grade: ${proposal.citizens.grade}${proposal.citizens.why?.length ? ` (${proposal.citizens.why.slice(0, 2).join('; ')})` : ''}` : ''}${deflt}${proposal?.status === 'voting' ? '\nYour grade:' : ''}`, proposal?.status === 'voting' ? gradeButtons(proposal.id) : null);
      }
      if (n) saveWorldSoon();
      return n;
    },
    stop() { stopped = true; },
  };
}
