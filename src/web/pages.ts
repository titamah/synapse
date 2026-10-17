// Public policy pages required by Meta for the Instagram app.
// Plain HTML so they load fast and need no build step.

const CONTACT_EMAIL = 'help@bostonblerds.com';
const UPDATED = 'October 16, 2026';

function layout(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Boston Blerds</title>
<style>
  :root { --bg: #ffffff; --fg: #1a1a1a; --muted: #5c5c5c; --accent: #b8860b; --rule: #e5e5e5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111111; --fg: #f0f0f0; --muted: #a8a8a8; --accent: #ffcc00; --rule: #2a2a2a; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 16px 64px; }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 4px; }
  h2 { font-size: 1.15rem; margin: 32px 0 8px; }
  p, li { color: var(--fg); }
  .muted { color: var(--muted); font-size: .9rem; }
  a { color: var(--accent); }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 32px 0; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export const privacyPage = layout(
  'Privacy Policy',
  `
<h1>Privacy Policy</h1>
<p class="muted">Boston Blerds · Last updated ${UPDATED}</p>

<p>Boston Blerds runs community programs, including giveaways, through our Discord bot (BB-Bot) and our Instagram account, <a href="https://instagram.com/bostonblerds">@BostonBlerds</a>. This policy explains what information we collect through those tools, why, and how you can have it deleted.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>From Discord:</strong> your Discord user ID and username, and the Instagram username you submit with <code>/giveaway enter</code>.</li>
  <li><strong>From Instagram:</strong> when you comment on or mention @BostonBlerds in a post or Story connected to a giveaway, we receive your Instagram username, the comment or mention, and when it happened. We only receive activity directed at our own account.</li>
  <li><strong>From event tickets:</strong> if you attend a Boston Blerds event, whether your ticket was scanned and the Instagram username you provided at checkout.</li>
</ul>
<p>We do not collect passwords, payment information, or private messages unrelated to our giveaways.</p>

<h2>How we use it</h2>
<ul>
  <li>To record giveaway entries and bonus entries, check eligibility, and pick and contact winners.</li>
  <li>To prevent duplicate or fraudulent entries.</li>
</ul>
<p>We do not sell your information or use it for advertising.</p>

<h2>Who can see it</h2>
<p>Only Boston Blerds organizers. Our data is stored on servers we control, hosted by Oracle Cloud and served through Cloudflare, who process it only to run our service. We do not share it with anyone else unless required by law.</p>

<h2>How long we keep it</h2>
<p>Giveaway data is deleted within 90 days after the giveaway ends, except the winner's record, which we keep for one year for our records.</p>

<h2>Your choices</h2>
<p>You can update your Instagram username anytime by running <code>/giveaway enter</code> again. You can ask us to delete your data at any time. See <a href="/data-deletion">Data Deletion</a>.</p>

<h2>Contact</h2>
<p>Questions? Email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> or message an admin in the Boston Blerds Discord.</p>

<hr>
<p class="muted">We may update this policy. Changes will be posted on this page with a new date.</p>
`,
);

export const dataDeletionPage = layout(
  'Data Deletion',
  `
<h1>Data Deletion Instructions</h1>
<p class="muted">Boston Blerds · Last updated ${UPDATED}</p>

<p>You can ask Boston Blerds to delete all information we hold about you from our giveaways and community tools, including your Discord ID and username, your Instagram username, and any comments, mentions, or event check-ins we recorded.</p>

<h2>How to request deletion</h2>
<ol>
  <li>Email <a href="mailto:${CONTACT_EMAIL}?subject=Data%20deletion%20request">${CONTACT_EMAIL}</a> with the subject <strong>"Data deletion request"</strong>, or message an admin in the Boston Blerds Discord.</li>
  <li>Include your Discord username and/or Instagram username so we can find your records.</li>
</ol>

<h2>What happens next</h2>
<p>We will confirm your request and delete your data within <strong>30 days</strong>. If you are in an active giveaway, deleting your data also removes your entry.</p>

<h2>Removing app access on Instagram</h2>
<p>Our app only reads activity on the @BostonBlerds account; it never logs in as you. If you ever connected an app to your own Instagram, you can remove it in Instagram under <em>Settings → Website permissions → Apps and websites</em>.</p>

<hr>
<p class="muted">See our <a href="/privacy">Privacy Policy</a> for details on what we collect.</p>
`,
);
