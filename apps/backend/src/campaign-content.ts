import {
  campaignVariables,
  type CampaignContent,
  type CampaignVariable,
  type CampaignVars,
} from '../../../packages/contracts/src/campaigns';

/**
 * Campaign templates are a small, safe subset of Markdown rendered into the branded email
 * layout: headings, paragraphs, lists, bold and italic, inline code, links, a rule, and a
 * button (`[[Label]](https://…)`). Raw HTML is shown as text. `{{variable}}` placeholders are
 * filled in after rendering, escaped, so an account's own name can't add markup or links.
 */

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const unescape = (text: string) =>
  text.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]!,
  );
const safeUrl = (url: string) => /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(url);
const VARIABLE = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;
const isVariable = (name: string): name is CampaignVariable => name in campaignVariables;

const style = {
  h1: 'margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:650;letter-spacing:-0.01em;color:#16181d;',
  h2: 'margin:24px 0 10px;font-size:18px;line-height:1.35;font-weight:650;color:#16181d;',
  h3: 'margin:20px 0 8px;font-size:16px;line-height:1.4;font-weight:650;color:#16181d;',
  p: 'margin:0 0 16px;font-size:15px;line-height:1.6;color:#3d414b;',
  list: 'margin:0 0 16px;padding-left:22px;font-size:15px;line-height:1.6;color:#3d414b;',
  li: 'margin:0 0 6px;',
  a: 'color:#4353d9;',
  code: "padding:1px 5px;border-radius:4px;background:#f0f2f5;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:13px;",
  hr: 'margin:24px 0;border:0;border-top:1px solid #e3e5ea;',
};

type Rendered = { html: string; text: string };

/** One line of inline Markdown, as HTML and as plain text. */
function inline(source: string): Rendered {
  const codes: Rendered[] = [];
  // Code spans are set aside first so nothing inside them is formatted.
  let html = escape(source).replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push({ html: `<code style="${style.code}">${code}</code>`, text: unescape(code) });
    return `\u0000${codes.length - 1}\u0000`;
  });
  let text = html;
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) =>
    safeUrl(unescape(url)) ? `<a href="${url}" style="${style.a}">${label}</a>` : match,
  );
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) =>
    safeUrl(unescape(url)) ? `${label} (${url.replace(/^mailto:/i, '')})` : match,
  );
  const emphasis: [RegExp, string][] = [
    [/\*\*(?=\S)(.+?)\*\*/g, 'strong'],
    [/(^|[^\w*])\*(?=\S)(.+?)\*(?!\w)/g, 'em'],
    [/(^|[^\w])_(?=\S)(.+?)_(?!\w)/g, 'em'],
  ];
  for (const [pattern, tag] of emphasis) {
    html = html.replace(pattern, (...m: string[]) =>
      tag === 'strong'
        ? `<strong style="color:#16181d;">${m[1]}</strong>`
        : `${m[1]}<em>${m[2]}</em>`,
    );
    text = text.replace(pattern, (...m: string[]) => (tag === 'strong' ? m[1] : `${m[1]}${m[2]}`));
  }
  const restore = (value: string, part: keyof Rendered) =>
    value.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]![part]);
  return { html: restore(html, 'html'), text: unescape(restore(text, 'text')) };
}

const button = (label: string, url: string): Rendered => ({
  html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;"><tr><td style="background:#4353d9;border-radius:8px;"><a href="${escape(url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${inline(label).html}</a></td></tr></table>`,
  text: `${inline(label).text}: ${url}`,
});

/** The Markdown body as HTML (the inside of the email card) and as plain text. */
export function renderMarkdown(markdown: string): Rendered {
  const html: string[] = [];
  const text: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  const flush = () => {
    if (paragraph.length) {
      const lines = paragraph.map(inline);
      html.push(`<p style="${style.p}">${lines.map((l) => l.html).join('<br>')}</p>`);
      text.push(lines.map((l) => l.text).join('\n'));
      paragraph = [];
    }
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul';
      const items = list.items.map(inline);
      html.push(
        `<${tag} style="${style.list}">${items.map((i) => `<li style="${style.li}">${i.html}</li>`).join('')}</${tag}>`,
      );
      text.push(items.map((i, n) => `${list!.ordered ? `${n + 1}.` : '-'} ${i.text}`).join('\n'));
      list = undefined;
    }
  };
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const item = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.+)$/);
    const cta = line.trim().match(/^\[\[(.+?)\]\]\((\S+)\)$/);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      const level = heading[1]!.length as 1 | 2 | 3;
      const content = inline(heading[2]!);
      html.push(`<h${level} style="${style[`h${level}`]}">${content.html}</h${level}>`);
      text.push(content.text);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      html.push(`<hr style="${style.hr}">`);
      text.push('---');
    } else if (cta && safeUrl(cta[2]!)) {
      flush();
      const rendered = button(cta[1]!, cta[2]!);
      html.push(rendered.html);
      text.push(rendered.text);
    } else if (item) {
      const ordered = !!item[2];
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[3]!);
    } else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return { html: html.join('\n'), text: text.join('\n\n') };
}

const fill = (value: string, vars: CampaignVars, html: boolean) =>
  value.replace(VARIABLE, (match, name: string) =>
    isVariable(name) ? (html ? escape(vars[name]) : vars[name]) : match,
  );

/** What would stop the content from being sent: unknown variables and unsafe links. */
export function contentProblems(content: Pick<CampaignContent, 'subject' | 'preheader' | 'markdown'>) {
  const problems: string[] = [];
  const unknown = new Set<string>();
  for (const part of [content.subject, content.preheader, content.markdown])
    for (const [, name] of part.matchAll(VARIABLE)) if (!isVariable(name!)) unknown.add(name!);
  for (const name of unknown)
    problems.push(
      `{{${name}}} is not a variable. Use one of: ${Object.keys(campaignVariables)
        .map((v) => `{{${v}}}`)
        .join(', ')}.`,
    );
  for (const [, url] of content.markdown.matchAll(/\]\(([^)\s]+)\)/g))
    if (!safeUrl(url!)) problems.push(`The link "${url}" must start with https://, http:// or mailto:.`);
  return problems;
}

/** The content for one recipient: subject, preview line, and the body as HTML and text. */
export function renderCampaign(content: CampaignContent, vars: CampaignVars) {
  const body = renderMarkdown(content.markdown);
  return {
    subject: fill(content.subject, vars, false),
    preheader: fill(content.preheader, vars, false),
    html: fill(body.html, vars, true),
    text: fill(body.text, vars, false),
  };
}

const size = (bytes: number) =>
  bytes >= 1e9 ? `${+(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / 1e6))} MB`;

/** Variables for an account, from its profile. */
export function campaignVars(account: {
  displayName?: string;
  username?: string;
  email: string;
  storageUsedBytes?: number;
  storageQuotaBytes?: number;
}): CampaignVars {
  const name = account.displayName?.trim() || account.username || account.email.split('@')[0]!;
  return {
    name,
    firstName: name.split(/\s+/)[0]!,
    username: account.username ?? '',
    email: account.email,
    storageUsed: size(account.storageUsedBytes ?? 0),
    storageQuota: size(account.storageQuotaBytes ?? 0),
  };
}

/** Stand-in values for previews and tests without a sample account. */
export const sampleVars: CampaignVars = {
  name: 'Alex Morgan',
  firstName: 'Alex',
  username: 'alex',
  email: 'alex@example.com',
  storageUsed: '3.2 GB',
  storageQuota: '50 GB',
};
