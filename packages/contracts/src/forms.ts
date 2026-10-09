import { z } from 'zod';
import { auditEntrySchema } from './admin';

/**
 * Forms (surveys) made in the management console. Each has its own link that can be shared
 * anywhere; an email template links to one with `{{form:<id>}}`, which gives each recipient a
 * personal link so their answers are known to be theirs. Staff open and close a form to
 * start and stop taking answers.
 */

export const formQuestionKind = z.enum(['RATING', 'CHOICE', 'MULTI', 'TEXT']);
export type FormQuestionKind = z.infer<typeof formQuestionKind>;
export const MAX_FORM_QUESTIONS = 20;
export const MAX_FORM_OPTIONS = 12;
export const MAX_FORM_TEXT = 2000;
export const formQuestionSchema = z
  .object({
    /** Stable within the form; answers are keyed by it. */
    id: z.string().regex(/^[a-z0-9]{1,16}$/),
    kind: formQuestionKind,
    prompt: z.string().trim().min(1).max(300),
    /** The choices of a CHOICE or MULTI question. */
    options: z.array(z.string().trim().min(1).max(100)).max(MAX_FORM_OPTIONS).default([]),
    /** A RATING's scale: 1 to 5, or 0 to 10. */
    scale: z.union([z.literal(5), z.literal(10)]).default(5),
    required: z.boolean().default(false),
  })
  .strict();
export type FormQuestion = z.infer<typeof formQuestionSchema>;

/** A rating, a choice's option index, chosen option indexes, or text. */
export const formAnswer = z.union([
  z.number().int().min(0).max(10),
  z.array(z.number().int().min(0).max(MAX_FORM_OPTIONS - 1)).max(MAX_FORM_OPTIONS),
  z.string().max(MAX_FORM_TEXT),
]);
export type FormAnswer = z.infer<typeof formAnswer>;
export const formAnswers = z.record(z.string(), formAnswer);
export type FormAnswers = z.infer<typeof formAnswers>;

/**
 * Who may answer: anyone with the link, or only people who can be identified — signed in to
 * harbor0, or opening their personal link from a campaign email.
 */
export const formAudience = z.enum(['ANYONE', 'IDENTIFIED']);
export type FormAudience = z.infer<typeof formAudience>;
/** One response per person (sending again replaces it), or a new response every time. */
export const formLimit = z.enum(['ONE_PER_PERSON', 'UNLIMITED']);
export type FormLimit = z.infer<typeof formLimit>;

const staffStamp = {
  createdAt: z.string(),
  createdBy: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
};
export const formInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(''),
    questions: z.array(formQuestionSchema).min(1).max(MAX_FORM_QUESTIONS),
    audience: formAudience.default('ANYONE'),
    limit: formLimit.default('ONE_PER_PERSON'),
  })
  .strict();
export type FormInput = z.input<typeof formInput>;
export const formBody = formInput
  .extend({
    /** The `updatedAt` the editor loaded; a save is refused if someone changed it since. */
    expectedUpdatedAt: z.string().nullable(),
  })
  .strict();
export const formSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  questions: z.array(formQuestionSchema),
  audience: formAudience,
  limit: formLimit,
  /** Whether the form takes answers now. A new form starts closed. */
  accepting: z.boolean(),
  responseCount: z.number(),
  lastResponseAt: z.string().nullable(),
  /** The page anyone with the link can answer it on. */
  link: z.string(),
  ...staffStamp,
});
export type Form = z.infer<typeof formSchema>;
export const formListSchema = z.object({ items: z.array(formSchema) });
export const formDetailSchema = z.object({
  form: formSchema,
  history: z.array(auditEntrySchema),
});
export type FormDetail = z.infer<typeof formDetailSchema>;
export const formAcceptingBody = z.object({ accepting: z.boolean() }).strict();

/** How a response's author was known. */
export const respondentVia = z.enum(['EMAIL', 'ACCOUNT', 'BROWSER', 'ANONYMOUS']);
export type RespondentVia = z.infer<typeof respondentVia>;
export const formResponseSchema = z.object({
  id: z.string(),
  via: respondentVia,
  /** The account, when the respondent was signed in or their email link names one. */
  userId: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  answers: formAnswers,
  submittedAt: z.string(),
});
export type FormResponse = z.infer<typeof formResponseSchema>;
export const formResponsesSchema = z.object({ items: z.array(formResponseSchema) });
export type FormResponses = z.infer<typeof formResponsesSchema>;

// The public form page ------------------------------------------------------------------------
export const publicFormSchema = formSchema.pick({
  id: true,
  title: true,
  description: true,
  questions: true,
  audience: true,
  limit: true,
  accepting: true,
});
export type PublicForm = z.infer<typeof publicFormSchema>;
export const formViewSchema = z.object({
  form: publicFormSchema,
  /** Who the answers will be recorded as; null when no one is known yet. */
  respondent: z
    .object({
      via: respondentVia,
      /** A masked email address, or null for a browser. */
      label: z.string().nullable(),
    })
    .nullable(),
  /** This respondent's earlier answers, for a one-per-person form. */
  response: z.object({ answers: formAnswers, submittedAt: z.string() }).nullable(),
  /** Why answers can't be sent now, if they can't. */
  blocked: z.enum(['CLOSED', 'SIGN_IN', 'TEST']).nullable(),
});
export type FormView = z.infer<typeof formViewSchema>;
/** Browser IDs are random strings a browser keeps for itself; they name no one. */
export const browserId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export const formSubmitBody = z
  .object({
    answers: formAnswers,
    /** The personal token from a campaign email's form link. */
    r: z.string().max(400).optional(),
    browser: browserId.optional(),
  })
  .strict();
export const formSubmitResultSchema = z.object({
  submittedAt: z.string(),
  /** True when this replaced the respondent's earlier answers. */
  replaced: z.boolean(),
});
