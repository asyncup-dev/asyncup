import type { Response } from 'express';
import type { Session } from '../auth/session.js';

/** Shared page chrome for the admin dashboard and the /me user console. */

export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="28" height="28"><g fill="#fff" opacity=".96"><rect x="24" y="28" width="208" height="168" rx="52"/><path d="M86 188 L60 236 Q54 247 68 240 L132 196 Z"/></g><rect x="66" y="120" width="30" height="44" rx="15" fill="#FFD27D"/><rect x="113" y="92" width="30" height="72" rx="15" fill="#FFAE52"/><rect x="160" y="64" width="30" height="100" rx="15" fill="#FF8A3D"/></svg>';

/** The one sign-in card, shared by the dashboard 401 page and /me. */
export function signInCard(opts: {
  kicker: string;
  heading: string;
  google: boolean;
  saml: boolean;
  /** Render an operator-token entry form (the dashboard card only). */
  tokenForm?: boolean;
  footnotes: string[];
}): string {
  const { google, saml } = opts;
  return `<section class="card" style="max-width:420px;margin:3rem auto;text-align:center">
    <div class="kicker">${esc(opts.kicker)}</div>
    <h2>${esc(opts.heading)}</h2>
    ${google ? '<a class="btn" href="/auth/google">Sign in with Google</a>' : ''}
    ${saml ? `<p${google ? ' style="margin-top:.6rem"' : ''}><a class="btn${google ? ' ghost' : ''}" href="/auth/saml">Sign in with SSO (SAML)</a></p>` : ''}
    ${
      opts.tokenForm
        ? `<form method="get" action="/dashboard" style="margin-top:${google || saml ? '1rem' : '.4rem'}">
            <input name="token" type="password" placeholder="DASHBOARD_TOKEN" autocomplete="off" style="max-width:260px">
            <button class="btn ghost" type="submit">Enter with token</button>
          </form>`
        : ''
    }
    ${opts.footnotes.map((n) => `<p><small class="muted">${n}</small></p>`).join('')}
  </section>`;
}

/** 404 with a consistent page body. */
export function notFound(res: Response, message: string, active: NavState = 'home'): void {
  res.status(404).send(layout('Not found', active, `<div class="card"><p>${esc(message)}</p></div>`));
}

type NavState = 'home' | 'settings' | 'me';

export function layout(title: string, active: NavState, body: string, opts: { user?: Session } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{
    --ink:#15435f; --ink-deep:#0c2c40; --ink-faint:rgba(21,67,95,.14);
    --amber:#ff8a3d; --amber-soft:#ffae52; --amber-pale:#ffd27d;
    --paper:#faf6ef; --card:#fffdf9; --text:#22323d; --muted:#68798a;
    --serif:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
    --sans:'Avenir Next',Avenir,Seravek,'Segoe UI Variable Text','Segoe UI',Verdana,sans-serif;
    --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{
    margin:0;color:var(--text);font:15px/1.55 var(--sans);
    background:
      radial-gradient(1100px 360px at 50% -180px, rgba(255,174,82,.22), transparent 70%),
      radial-gradient(900px 300px at 85% -120px, rgba(21,67,95,.10), transparent 70%),
      var(--paper);
    min-height:100vh;
  }
  header{
    background:linear-gradient(180deg,var(--ink) 0%,var(--ink-deep) 100%);
    border-bottom:3px solid var(--amber);
  }
  .bar{max-width:1020px;margin:0 auto;padding:.85rem 1.2rem;display:flex;align-items:center;gap:.7rem}
  .bar .word{font-family:var(--serif);font-size:1.25rem;color:#fff;letter-spacing:.01em;text-decoration:none}
  .bar .word em{font-style:normal;color:var(--amber-soft)}
  nav{margin-left:auto;display:flex;gap:.4rem}
  nav a{color:rgba(255,255,255,.85);text-decoration:none;padding:.35rem .8rem;border-radius:999px;font-size:.92rem}
  nav a:hover{background:rgba(255,255,255,.12)}
  nav a.active{background:var(--amber);color:#3b2204;font-weight:600}
  main{max-width:1020px;margin:1.6rem auto 4rem;padding:0 1.2rem}
  h1{font-family:var(--serif);font-weight:600;font-size:1.9rem;margin:.2rem 0 1rem;color:var(--ink-deep)}
  h1 small{color:var(--muted);font-family:var(--sans);font-size:.95rem}
  h2{font-family:var(--serif);font-weight:600;font-size:1.25rem;margin:.1rem 0 .8rem;color:var(--ink-deep)}
  .kicker{font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--amber);margin-bottom:.15rem}
  .muted{color:var(--muted)} .crumbs{margin:.2rem 0 .6rem}
  a{color:#176d94}
  .card{
    background:var(--card);border:1px solid var(--ink-faint);border-radius:12px;
    padding:1.1rem 1.3rem 1.2rem;margin:0 0 1.1rem;box-shadow:0 1px 2px rgba(21,67,95,.05),0 10px 30px -18px rgba(21,67,95,.25);
    animation:rise .45s ease both;
  }
  .card:not(.acc):nth-of-type(2){animation-delay:.06s}.card:not(.acc):nth-of-type(3){animation-delay:.12s}.card:not(.acc):nth-of-type(4){animation-delay:.18s}
  details.acc{animation:none}
  @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: reduce){.card{animation:none}}
  table{border-collapse:collapse;width:100%;margin:.5rem 0;font-size:.93rem}
  th,td{border-bottom:1px solid var(--ink-faint);padding:.45rem .6rem;text-align:left}
  th{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700}
  tr:hover td{background:rgba(255,174,82,.06)}
  label{display:block;margin:.6rem 0;font-weight:600;font-size:.92rem}
  label small{font-weight:400}
  label.inline{display:flex;gap:.5rem;align-items:baseline;font-weight:500}
  label.inline.big{margin:.9rem 0}
  input,textarea,select{
    width:100%;max-width:380px;padding:.45rem .6rem;font:inherit;margin-top:.25rem;
    border:1px solid var(--ink-faint);border-radius:8px;background:#fff;color:var(--text);
  }
  textarea{max-width:100%;font-family:var(--mono);font-size:.82rem}
  input[type=checkbox]{width:auto;accent-color:var(--amber)}
  input:focus,textarea:focus,select:focus{outline:2px solid var(--amber-soft);outline-offset:1px;border-color:var(--amber)}
  .btn{
    display:inline-block;margin-top:.7rem;padding:.5rem 1.5rem;font:inherit;font-weight:700;
    background:var(--amber);color:#3b2204;border:0;border-radius:999px;cursor:pointer;
    transition:transform .15s,background .15s;text-decoration:none;
  }
  .btn:hover{background:var(--amber-soft);transform:translateY(-1px)}
  .btn.ghost{background:transparent;border:1.5px solid var(--ink-faint);color:var(--ink);padding:.35rem 1rem;font-weight:600}
  .btn.ghost:hover{border-color:var(--amber);background:rgba(255,174,82,.08)}
  .btn.ghost.danger{color:#a33a17}
  /* settings accordions — status readable while collapsed */
  details.acc{padding:0}
  details.acc>summary{
    list-style:none;cursor:pointer;display:flex;align-items:baseline;gap:.7rem;
    padding:1rem 1.3rem;border-radius:12px;
  }
  details.acc>summary::-webkit-details-marker{display:none}
  details.acc>summary::after{content:"▸";margin-left:auto;color:var(--muted);transition:transform .15s}
  details.acc[open]>summary::after{transform:rotate(90deg)}
  details.acc>summary:hover{background:rgba(255,174,82,.06)}
  .sum-title{font-family:var(--serif);font-weight:600;font-size:1.15rem;color:var(--ink-deep);white-space:nowrap}
  .sum-desc{color:var(--muted);font-size:.88rem;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sum-status{flex:none}
  .acc-body{padding:0 1.3rem 1.2rem;border-top:1px dashed var(--ink-faint);padding-top:.9rem}
  details.sub{border:1px solid var(--ink-faint);border-radius:10px;margin:.7rem 0;background:rgba(255,255,255,.5)}
  details.sub>summary{list-style:none;cursor:pointer;display:flex;align-items:baseline;gap:.7rem;padding:.7rem 1rem}
  details.sub>summary::-webkit-details-marker{display:none}
  details.sub>summary::after{content:"▸";margin-left:auto;color:var(--muted)}
  details.sub[open]>summary::after{transform:rotate(90deg)}
  details.sub>summary .sum-title{font-size:.98rem;font-family:var(--sans);font-weight:700}
  details.sub>form,details.sub>div{padding:0 1rem .9rem}
  details.hint{margin:.2rem 0 .6rem}
  details.hint>summary{cursor:pointer;font-size:.85rem;color:#176d94;list-style:none}
  details.hint>summary::-webkit-details-marker{display:none}
  details.hint p{font-size:.85rem;color:var(--muted);margin:.35rem 0 0;background:rgba(21,67,95,.05);border-radius:8px;padding:.5rem .7rem}
  /* master-toggle reveal: fields hidden until the checkbox is on */
  .gated{display:none}
  .ai-form:has(input[name="aiOn"]:checked) .gated{display:block}
  input.wide,select.wide{max-width:100%}
  label>input,label>select,label>textarea{display:block}
  .inline-form{display:inline}
  .inline-form .btn{margin-top:0;padding:.15rem .6rem;font-size:.78rem}
  .row-actions{margin-left:.5rem;opacity:.35;transition:opacity .15s}
  li:hover .row-actions,h1:hover .row-actions{opacity:1}
  .chart-title{font-family:var(--sans);font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:.9rem 0 .3rem}
  .chart-title:first-of-type{margin-top:.2rem}
  .chart-data{margin-top:.6rem}
  .chart-data summary{cursor:pointer;font-size:.85rem;color:var(--muted)}
  .card.warn{border-color:#f3cfc2;background:#fdf3ef}
  .card.warn .kicker{color:#a33a17}
  .toast{border-radius:10px;padding:.6rem 1rem;margin:.4rem 0 1rem;font-weight:600;animation:rise .3s ease both}
  .toast.ok{background:#e8f5ec;color:#176a37;border:1px solid #bfe3cb}
  .toast.err{background:#fdeeea;color:#a33a17;border:1px solid #f3cfc2}
  .tag{background:rgba(21,67,95,.08);border-radius:4px;padding:.05rem .4rem;font-size:.78rem;margin-left:.3rem}
  .chip{font-size:.75rem;font-weight:700;border-radius:999px;padding:.12rem .6rem}
  .chip.on{background:#e8f5ec;color:#176a37}.chip.off{background:rgba(21,67,95,.08);color:var(--muted)}
  .cols{display:grid;grid-template-columns:1.1fr .9fr;gap:1.1rem}
  @media(max-width:760px){.cols{grid-template-columns:1fr}}
  .sub h3{margin:.1rem 0 .5rem}
  .token-row{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;padding:.8rem 0;border-bottom:1px solid var(--ink-faint)}
  .token-row:last-child{border-bottom:none}
  .token-row small{display:block;margin:.1rem 0 .35rem}
  .token-actions{display:flex;gap:.5rem;flex-shrink:0}
  .reveal{margin-top:.5rem;background:#fff7ea;border:1px dashed var(--amber);border-radius:8px;padding:.5rem .8rem;font-size:.85rem}
  .reveal code{display:block;font-family:var(--mono);font-size:.85rem;margin-top:.25rem;word-break:break-all}
  /* setup checklist — the logo's ascending bars as a progress meter */
  .setup h2{font-size:1.45rem}
  .meter{display:flex;align-items:flex-end;gap:6px;height:44px;margin:.4rem 0 1rem}
  .meter .bar{width:13px;border-radius:7px;background:rgba(21,67,95,.12);transition:background .3s}
  .meter .b1{height:16px}.meter .b2{height:25px}.meter .b3{height:34px}.meter .b4{height:43px}
  .meter .bar.done{background:linear-gradient(180deg,var(--amber-pale),var(--amber))}
  .meter-label{align-self:center;margin-left:.5rem;font-family:var(--serif);font-size:1.05rem;color:var(--ink)}
  .steps{list-style:none;margin:0;padding:0}
  .steps li{display:flex;gap:.8rem;align-items:center;padding:.55rem 0;border-bottom:1px dashed var(--ink-faint)}
  .steps li:last-child{border-bottom:none}
  .steps li.done{opacity:.55}
  .steps .tick{
    flex:none;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;
    border:1.5px solid var(--ink-faint);color:#176a37;font-weight:800;background:#fff;
  }
  .steps li.done .tick{background:#e8f5ec;border-color:#bfe3cb}
  .steps li div{flex:1} .steps small{display:block;color:var(--muted)}
</style></head><body>
<header><div class="bar">
  ${LOGO_SVG}
  <a class="word" href="/dashboard">Async<em>Up</em></a>
  <nav>
    ${
      active === 'me'
        ? `<a href="/me" class="active">My standups</a>${opts.user?.admin ? '<a href="/dashboard">Admin</a>' : ''}`
        : `<a href="/dashboard" class="${active === 'home' ? 'active' : ''}">Standups</a>
    <a href="/dashboard/settings" class="${active === 'settings' ? 'active' : ''}">Settings</a>
    <a href="/me">My standups</a>`
    }
  </nav>
</div></header>
<main>${body}</main>
</body></html>`;
}
