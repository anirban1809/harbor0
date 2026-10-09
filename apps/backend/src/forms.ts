import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeEmail } from '@harbor/contracts';
import {
  MAX_FORM_TEXT,
  type Form,
  type FormAnswers,
  type FormQuestion,
  type FormResponse,
  type FormView,
  type RespondentVia,
} from '../../../packages/contracts/src/forms';
import { accountIdFor, allRows } from './campaigns';
import { userPK, type Account } from './domain';
import { maskEmail, type EmailLinks } from './email-preferences';
import { assert } from './errors';
import { Transaction, transact, type Repository } from './repository';

/*
 * Rows (pk / sk):
 *   FORM / <id>               a form, with its response count
 *   FORM#<id> / RESP#<key>    one response
 * With one response per person, a response's key names its respondent — "U#<account>",
 * "E#<address>" (an emailed address without an account) or "B#<browser id>" — so sending again
 * replaces it. Otherwise each response gets a new "N#<time>#<random>" key.
 */
export const FORM_PK = 'FORM';
export const responsePK = (formId: string) => `FORM#${formId}`;
export const responseSK = (key: string) => `RESP#${key}`;
/** Short, so shared links stay short; the id schema allows - and _. */
export const newFormId = () => randomBytes(9).toString('base64url');

export type StoredForm = Omit<Form, 'link'>;
export type StoredResponse = FormResponse & { firstSubmittedAt: string };

/** Who is answering, as far as the request shows. */
export type Respondent = {
  key: string;
  via: Exclude<RespondentVia, 'ANONYMOUS'>;
  userId: string | null;
  email: string | null;
  name: string | null;
};
/** What a request says about its sender; `accountId` is set when it was signed in. */
export type RespondentHints = { r?: string; accountId?: string; browser?: string };

const profile = async (repo: Repository, userId: string) =>
  (await repo.get({ pk: userPK(userId), sk: 'PROFILE' }))?.data as Account | undefined;
const accountRespondent = async (
  repo: Repository,
  userId: string,
  via: 'EMAIL' | 'ACCOUNT',
): Promise<Respondent | undefined> => {
  const account = await profile(repo, userId);
  if (!account || account.deletedAt || account.suspendedAt) return undefined;
  return {
    key: `U#${userId}`,
    via,
    userId,
    email: account.email,
    name: account.displayName?.trim() || account.username || null,
  };
};

/**
 * The respondent, strongest evidence first: the personal token from a campaign email, then a
 * signed-in account, then the browser's own random ID. "TEST" for a test email's link.
 */
export async function resolveRespondent(
  repo: Repository,
  links: EmailLinks | undefined,
  hints: RespondentHints,
): Promise<Respondent | 'TEST' | undefined> {
  if (hints.r === 'test') return 'TEST';
  if (hints.r) {
    const subject = links?.verifyRespondent(hints.r);
    assert(subject, 'INVALID_LINK', 'This form link is not valid. Open it again from the email.', 400);
    if ('userId' in subject) {
      const found = await accountRespondent(repo, subject.userId, 'EMAIL');
      if (found) return found;
    } else {
      // An address that has signed up since answers as that account.
      const userId = await accountIdFor(repo, subject.email);
      const found = userId && (await accountRespondent(repo, userId, 'EMAIL'));
      if (found) return found;
      const email = normalizeEmail(subject.email);
      return { key: `E#${email}`, via: 'EMAIL', userId: null, email, name: null };
    }
  }
  if (hints.accountId) {
    const found = await accountRespondent(repo, hints.accountId, 'ACCOUNT');
    if (found) return found;
  }
  if (hints.browser)
    return { key: `B#${hints.browser}`, via: 'BROWSER', userId: null, email: null, name: null };
  return undefined;
}

/** What would stop a form's questions from being saved. */
export function formProblems(questions: FormQuestion[]) {
  const problems: string[] = [];
  const ids = new Set<string>();
  questions.forEach((q, i) => {
    const which = `Question ${i + 1}`;
    if (ids.has(q.id)) problems.push(`${which} has the same ID as another question.`);
    ids.add(q.id);
    if ((q.kind === 'CHOICE' || q.kind === 'MULTI') && q.options.length < 2)
      problems.push(`${which} needs at least two choices.`);
    if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length)
      problems.push(`${which} has the same choice twice.`);
  });
  return problems;
}

/**
 * Answers checked against the questions: unknown questions and out-of-range values are refused,
 * blank ones dropped, and every required question must be answered.
 */
export function checkAnswers(questions: FormQuestion[], given: FormAnswers) {
  const answers: FormAnswers = {};
  const known = new Set(questions.map((q) => q.id));
  for (const id of Object.keys(given))
    assert(known.has(id), 'VALIDATION_ERROR', 'An answer is for a question this form does not have.');
  for (const q of questions) {
    const value = given[q.id];
    const blank =
      value === undefined ||
      (typeof value === 'string' && !value.trim()) ||
      (Array.isArray(value) && !value.length);
    if (blank) {
      assert(!q.required, 'ANSWER_REQUIRED', `Answer “${q.prompt}” to send the form.`);
      continue;
    }
    const fits =
      q.kind === 'RATING'
        ? typeof value === 'number' && value >= (q.scale === 10 ? 0 : 1) && value <= q.scale
        : q.kind === 'CHOICE'
          ? typeof value === 'number' && value < q.options.length
          : q.kind === 'MULTI'
            ? Array.isArray(value) &&
              value.every((i) => i < q.options.length) &&
              new Set(value).size === value.length
            : typeof value === 'string' && value.length <= MAX_FORM_TEXT;
    assert(fits, 'VALIDATION_ERROR', `The answer to “${q.prompt}” is not one of its choices.`);
    answers[q.id] =
      typeof value === 'string'
        ? value.trim()
        : Array.isArray(value)
          ? [...value].sort((a, b) => a - b)
          : value;
  }
  assert(Object.keys(answers).length, 'ANSWER_REQUIRED', 'Answer at least one question to send the form.');
  return answers;
}

const getForm = async (repo: Repository, id: string) => {
  const form = await new Transaction(repo).get<StoredForm>(FORM_PK, id);
  assert(form, 'NOT_FOUND', 'This form doesn’t exist. It may have been deleted.', 404);
  return form;
};
const identified = (who: Respondent | 'TEST' | undefined) =>
  who === 'TEST' || who?.via === 'EMAIL' || who?.via === 'ACCOUNT';

/** The form page's view: the questions, who is answering, and their earlier answers. */
export async function formView(
  repo: Repository,
  links: EmailLinks | undefined,
  id: string,
  hints: RespondentHints,
): Promise<FormView> {
  const form = await getForm(repo, id);
  const who = await resolveRespondent(repo, links, hints);
  const earlier =
    who && who !== 'TEST' && form.limit === 'ONE_PER_PERSON'
      ? await new Transaction(repo).get<StoredResponse>(responsePK(id), responseSK(who.key))
      : undefined;
  return {
    form: {
      id: form.id,
      title: form.title,
      description: form.description,
      questions: form.questions,
      audience: form.audience,
      limit: form.limit,
      accepting: form.accepting,
    },
    respondent:
      who && who !== 'TEST'
        ? { via: who.via, label: who.email ? maskEmail(who.email) : null }
        : null,
    response: earlier ? { answers: earlier.answers, submittedAt: earlier.submittedAt } : null,
    blocked: !form.accepting
      ? 'CLOSED'
      : who === 'TEST'
        ? 'TEST'
        : form.audience === 'IDENTIFIED' && !identified(who)
          ? 'SIGN_IN'
          : null,
  };
}

export async function submitForm(
  repo: Repository,
  links: EmailLinks | undefined,
  id: string,
  hints: RespondentHints,
  given: FormAnswers,
) {
  const form = await getForm(repo, id);
  assert(form.accepting, 'FORM_CLOSED', 'This form isn’t taking answers now.', 409);
  const who = await resolveRespondent(repo, links, hints);
  assert(who !== 'TEST', 'TEST_LINK', 'This link came from a test email, so answers aren’t saved.', 409);
  assert(
    form.audience === 'ANYONE' || identified(who),
    'SIGN_IN_REQUIRED',
    'Sign in to harbor0, or open your link from the email, to answer this form.',
    403,
  );
  assert(
    form.limit === 'UNLIMITED' || who,
    'VALIDATION_ERROR',
    'This browser could not be identified. Reload the page and try again.',
  );
  const answers = checkAnswers(form.questions, given);
  const at = new Date().toISOString();
  const key =
    form.limit === 'ONE_PER_PERSON' ? who!.key : `N#${at}#${randomUUID().slice(0, 8)}`;
  return transact(repo, async (tx) => {
    const current = await tx.get<StoredForm>(FORM_PK, id);
    assert(current?.accepting, 'FORM_CLOSED', 'This form isn’t taking answers now.', 409);
    const previous = await tx.get<StoredResponse>(responsePK(id), responseSK(key));
    const row: StoredResponse = {
      id: key,
      via: who?.via ?? 'ANONYMOUS',
      userId: who?.userId ?? null,
      email: who?.email ?? null,
      name: who?.name ?? null,
      answers,
      submittedAt: at,
      firstSubmittedAt: previous?.firstSubmittedAt ?? at,
    };
    await tx.put(responsePK(id), responseSK(key), row);
    await tx.put(FORM_PK, id, {
      ...current,
      responseCount: current.responseCount + (previous ? 0 : 1),
      lastResponseAt: at,
    } satisfies StoredForm);
    return { submittedAt: at, replaced: !!previous };
  });
}

/** Every response to a form, newest first. */
export async function formResponses(repo: Repository, id: string) {
  await getForm(repo, id);
  const rows = await allRows<StoredResponse>(repo, responsePK(id), 'RESP#');
  rows.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return {
    items: rows.map(({ firstSubmittedAt: _, ...response }) => response),
  };
}
