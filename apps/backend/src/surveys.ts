import {
  MAX_SURVEY_TEXT,
  SURVEY_OPEN_DAYS,
  type Survey,
  type SurveyAnswers,
  type SurveyForm,
  type SurveyResponse,
  type SurveyResults,
} from '../../../packages/contracts/src/campaigns';
import {
  allRows,
  CAMPAIGN_PK,
  getRow,
  read,
  recipientPK,
  recipientSK,
  type StoredCampaign,
  type StoredRecipient,
} from './campaigns';
import type { EmailLinks } from './email-preferences';
import { assert } from './errors';
import { transact, type Repository } from './repository';

/*
 * Survey answers sit beside the campaign's recipient rows:
 *   CAMPAIGN#<id> / SURVEY#<key>   one recipient's answers; sending them again replaces them
 * The signed link in each email names the campaign and the recipient, so answering needs no
 * sign-in, and a link only ever reads or changes its own recipient's answers.
 */
export const surveySK = (key: string) => `SURVEY#${key}`;
export type StoredSurveyResponse = SurveyResponse & { key: string; firstSubmittedAt: string };

const closesAt = (campaign: StoredCampaign) =>
  new Date(Date.parse(campaign.startedAt ?? campaign.updatedAt) + SURVEY_OPEN_DAYS * 86400_000);

/** The campaign, its survey and the recipient a link is for; a link that isn't ours is refused. */
async function linkTarget(repo: Repository, links: EmailLinks | undefined, token: string | undefined) {
  const target = links && token ? links.verifySurvey(token) : undefined;
  assert(target, 'INVALID_LINK', 'This survey link is not valid.', 400);
  const tx = read(repo);
  const campaign = await tx.get<StoredCampaign>(CAMPAIGN_PK, target.campaignId);
  const recipient = await tx.get<StoredRecipient>(recipientPK(target.campaignId), recipientSK(target.key));
  const survey = campaign?.content?.survey;
  assert(campaign && survey && recipient?.status === 'SENT', 'INVALID_LINK', 'This survey link is not valid.', 400);
  return { campaign, survey, recipient, key: target.key };
}

/**
 * Answers checked against the survey: unknown questions and out-of-range values are refused,
 * blank ones dropped, and on a full submit every required question must be answered.
 */
export function checkAnswers(survey: Survey, given: SurveyAnswers, complete: boolean) {
  const answers: SurveyAnswers = {};
  const known = new Map(survey.questions.map((q) => [q.id, q]));
  for (const id of Object.keys(given))
    assert(known.has(id), 'VALIDATION_ERROR', 'An answer is for a question this survey does not have.');
  for (const q of survey.questions) {
    const value = given[q.id];
    const blank =
      value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);
    if (blank) {
      assert(!complete || !q.required, 'ANSWER_REQUIRED', `Answer “${q.prompt}” to send the survey.`);
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
            : typeof value === 'string' && value.length <= MAX_SURVEY_TEXT;
    assert(fits, 'VALIDATION_ERROR', `The answer to “${q.prompt}” is not one of its choices.`);
    answers[q.id] = typeof value === 'string' ? value.trim() : Array.isArray(value) ? [...value].sort((a, b) => a - b) : value;
  }
  return answers;
}

/** What the survey page shows for a link: the questions and any answers already sent. */
export async function surveyForm(
  repo: Repository,
  links: EmailLinks | undefined,
  token: string | undefined,
): Promise<SurveyForm> {
  const { campaign, survey, key } = await linkTarget(repo, links, token);
  const response = await read(repo).get<StoredSurveyResponse>(recipientPK(campaign.id), surveySK(key));
  const closes = closesAt(campaign);
  return {
    // The subject without its variables (and any comma they leave), e.g. "A quick question".
    title:
      campaign.content!.subject
        .replace(/\{\{[^}]*\}\}/g, '')
        .replace(/\s+([,.!?;:])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '') || 'Survey',
    survey,
    answers: response?.answers ?? null,
    submittedAt: response?.submittedAt ?? null,
    closesAt: closes.toISOString(),
    open: Date.now() < closes.getTime(),
  };
}

export async function submitSurvey(
  repo: Repository,
  links: EmailLinks | undefined,
  token: string | undefined,
  given: SurveyAnswers,
) {
  const { campaign, survey, recipient, key } = await linkTarget(repo, links, token);
  assert(Date.now() < closesAt(campaign).getTime(), 'SURVEY_CLOSED', 'This survey has closed.', 409);
  const answers = checkAnswers(survey, given, true);
  assert(Object.keys(answers).length, 'ANSWER_REQUIRED', 'Answer at least one question to send the survey.');
  const at = new Date().toISOString();
  await transact(repo, async (tx) => {
    const previous = await tx.get<StoredSurveyResponse>(recipientPK(campaign.id), surveySK(key));
    const row: StoredSurveyResponse = {
      key,
      userId: recipient.userId,
      email: recipient.email,
      name: recipient.name,
      answers,
      submittedAt: at,
      firstSubmittedAt: previous?.firstSubmittedAt ?? at,
    };
    await tx.put(recipientPK(campaign.id), surveySK(key), row);
  });
  return { submittedAt: at };
}

/** Every answer a campaign's survey got, for the console. */
export async function surveyResults(repo: Repository, campaignId: string): Promise<SurveyResults> {
  const campaign = await getRow<StoredCampaign>(read(repo), CAMPAIGN_PK, campaignId, 'campaign');
  const rows = await allRows<StoredSurveyResponse>(repo, recipientPK(campaignId), 'SURVEY#');
  rows.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return {
    survey: campaign.content?.survey ?? null,
    sent: campaign.counts.sent,
    items: rows.map(({ userId, email, name, answers, submittedAt }) => ({
      userId,
      email,
      name,
      answers,
      submittedAt,
    })),
  };
}
