import {
  campaignUrlVariables,
  campaignVariables,
  type CampaignContent,
  type CampaignVariable,
  type CampaignVars,
  type Survey,
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
const VARIABLE = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;
// `{{survey}}` on a line of its own places the survey; it isn't a variable.
const SURVEY_LINE = /^\s*\{\{\s*survey\s*\}\}\s*$/;
const SURVEY_SLOT = '\u0001survey\u0001';
const isVariable = (name: string): name is CampaignVariable => name in campaignVariables;
// A link variable alone (`{{signupLink}}`) is a URL too: it is always filled with an https link.
const urlVariable = (url: string) => {
  const name = url.match(/^\{\{\s*([a-zA-Z]+)\s*\}\}$/)?.[1];
  return !!name && isVariable(name) && campaignUrlVariables.includes(name);
};
const safeUrl = (url: string) =>
  /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(url) || urlVariable(url);

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
    else if (SURVEY_LINE.test(line)) {
      flush();
      html.push(SURVEY_SLOT);
      text.push(SURVEY_SLOT);
    } else if (heading) {
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

/** What would stop the content from being sent: unknown variables, unsafe links, a bad survey. */
export function contentProblems(
  content: Pick<CampaignContent, 'subject' | 'preheader' | 'markdown'> & {
    survey?: Survey | null;
  },
) {
  const problems: string[] = [];
  const unknown = new Set<string>();
  const markdown = content.markdown
    .split(/\r?\n/)
    .filter((line) => !SURVEY_LINE.test(line))
    .join('\n');
  for (const part of [content.subject, content.preheader, markdown])
    for (const [, name] of part.matchAll(VARIABLE))
      if (name === 'survey')
        problems.push('Put {{survey}} on a line of its own to place the survey there.');
      else if (!isVariable(name!)) unknown.add(name!);
  if (!content.survey && markdown !== content.markdown)
    problems.push('The message places a survey with {{survey}}, but it has no questions.');
  problems.push(...surveyProblems(content.survey));
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

function surveyProblems(survey: Survey | null | undefined) {
  if (!survey) return [];
  const problems: string[] = [];
  const ids = new Set<string>();
  survey.questions.forEach((q, i) => {
    const which = `Survey question ${i + 1}`;
    if (ids.has(q.id)) problems.push(`${which} has the same ID as another question.`);
    ids.add(q.id);
    if ((q.kind === 'CHOICE' || q.kind === 'MULTI') && q.options.length < 2)
      problems.push(`${which} needs at least two choices.`);
    if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length)
      problems.push(`${which} has the same choice twice.`);
  });
  return problems;
}

/** The answers a question takes in its email link: a rating's values or a choice's options. */
export function oneClickAnswers(question: Survey['questions'][number]) {
  if (question.kind === 'RATING')
    return Array.from({ length: question.scale === 10 ? 11 : 5 }, (_, i) => {
      const value = question.scale === 10 ? i : i + 1;
      return { value, label: String(value) };
    });
  if (question.kind === 'CHOICE') return question.options.map((label, value) => ({ value, label }));
  return [];
}

const surveyStyle = {
  box: 'margin:8px 0 20px;padding:16px 12px;border:1px solid #e3e5ea;border-radius:10px;background:#f7f8fa;',
  prompt: 'margin:0 0 14px;font-size:15px;line-height:1.5;font-weight:600;color:#16181d;',
  scale:
    'display:block;padding:10px 0;border:1px solid #c9cdd6;border-radius:6px;background:#ffffff;font-size:15px;font-weight:600;color:#4353d9;text-align:center;text-decoration:none;',
  choice:
    'display:block;margin:0 0 8px;padding:11px 14px;border:1px solid #c9cdd6;border-radius:8px;background:#ffffff;font-size:15px;color:#16181d;text-decoration:none;',
  ends: 'padding:6px 2px 0;font-size:12px;color:#8a8f9c;',
  more: 'margin:14px 0 0;font-size:13px;line-height:1.5;color:#5d6270;',
};

/**
 * The survey as it shows in the email. A rating or single choice first question is answered
 * by its link; anything else, and the rest of the survey, is on the page the link opens.
 */
export function renderSurvey(survey: Survey, link: string): Rendered {
  const first = survey.questions[0]!;
  const answers = oneClickAnswers(first);
  const href = (value: number) => escape(`${link}${link.includes('?') ? '&' : '?'}a=${value}`);
  const html: string[] = [`<div style="${surveyStyle.box}">`];
  const text: string[] = [];
  const more = survey.questions.length - 1;
  if (answers.length) {
    html.push(`<p style="${surveyStyle.prompt}">${escape(first.prompt)}</p>`);
    text.push(first.prompt);
    if (first.kind === 'RATING') {
      const width = Math.floor(100 / answers.length);
      html.push(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${answers
          .map(
            (a) =>
              `<td width="${width}%" style="padding:0 1px;"><a href="${href(a.value)}" style="${surveyStyle.scale}">${a.label}</a></td>`,
          )
          .join('')}</tr></table>`,
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="${surveyStyle.ends}">${first.scale === 10 ? 'Not likely' : 'Poor'}</td><td align="right" style="${surveyStyle.ends}">${first.scale === 10 ? 'Very likely' : 'Great'}</td></tr></table>`,
      );
    } else
      html.push(
        ...answers.map((a) => `<a href="${href(a.value)}" style="${surveyStyle.choice}">${escape(a.label)}</a>`),
      );
    text.push(...answers.map((a) => `${a.label}: ${link}${link.includes('?') ? '&' : '?'}a=${a.value}`));
    html.push(
      `<p style="${surveyStyle.more}">${
        more
          ? `Pick one to answer, then ${more === 1 ? 'one more short question' : `${more} more short questions`} on the next page.`
          : 'Pick one to answer.'
      }</p>`,
    );
  } else {
    const count = survey.questions.length;
    html.push(
      `<p style="${surveyStyle.prompt}">${count === 1 ? escape(first.prompt) : `We'd love your answers to ${count} short questions.`}</p>`,
    );
    const cta = button('Answer the survey', link);
    html.push(cta.html.replace('margin:4px 0 20px;', 'margin:0;'));
    text.push(count === 1 ? first.prompt : `We'd love your answers to ${count} short questions.`, cta.text);
  }
  html.push('</div>');
  return { html: html.join(''), text: text.join('\n') };
}

/**
 * The content for one recipient: subject, preview line, and the body as HTML and text. A
 * survey goes where the body says `{{survey}}`, or at the end; `surveyLink` is this recipient's
 * own link to answer it.
 */
export function renderCampaign(content: CampaignContent, vars: CampaignVars, surveyLink?: string) {
  const body = renderMarkdown(content.markdown);
  let html = fill(body.html, vars, true);
  let text = fill(body.text, vars, false);
  const survey = content.survey && surveyLink ? renderSurvey(content.survey, surveyLink) : undefined;
  const place = (value: string, part: string, joiner: string) =>
    value.includes(SURVEY_SLOT)
      ? value.split(SURVEY_SLOT).join(part)
      : part
        ? `${value}${joiner}${part}`
        : value;
  html = place(html, survey?.html ?? '', '\n');
  text = place(text, survey?.text ?? '', '\n\n');
  return {
    subject: fill(content.subject, vars, false),
    preheader: fill(content.preheader, vars, false),
    html,
    text,
  };
}

const size = (bytes: number) =>
  bytes >= 1e9 ? `${+(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / 1e6))} MB`;

/**
 * Variables for a recipient: an account, from its profile, or an address without one, which
 * only has its email. `signupLink` is filled in by the sender.
 */
export function campaignVars(
  account: {
    displayName?: string;
    username?: string;
    email: string;
    storageUsedBytes?: number;
    storageQuotaBytes?: number;
  },
  signupLink: string,
): CampaignVars {
  const name = account.displayName?.trim() || account.username || account.email.split('@')[0]!;
  return {
    signupLink,
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
  signupLink: 'https://app.harbor0.com/signup?invite=sample',
};
