import { z } from 'zod';
import { auditEntrySchema } from './admin';
import { id } from './index';

/**
 * Email campaigns sent from the management console: templates written in Markdown, named
 * groups of accounts, and one-off sends to them, now or at a set time. Only accounts ever get
 * campaign email.
 */

/** Product updates can be unsubscribed from; service notices (terms, pricing) cannot. */
export const campaignCategory = z.enum(['PRODUCT', 'SERVICE']);
export type CampaignCategory = z.infer<typeof campaignCategory>;

/** Placeholders a template may use, filled in for each recipient. */
export const campaignVariables = {
  name: 'Display name',
  firstName: 'First word of the display name',
  username: 'Username',
  email: 'Email address',
  storageUsed: 'Storage used, e.g. 3.2 GB',
  storageQuota: 'Storage limit, e.g. 50 GB',
} as const;
export type CampaignVariable = keyof typeof campaignVariables;
export type CampaignVars = Record<CampaignVariable, string>;

const reason = z.string().trim().min(3).max(500);
const staffStamp = {
  createdAt: z.string(),
  createdBy: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
};
/** The `updatedAt` an editor loaded; a save is refused if someone changed it since. */
const expectedUpdatedAt = z.string().nullable();

export const campaignContentSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  /** The preview line mail apps show after the subject. */
  preheader: z.string().trim().max(200).default(''),
  markdown: z.string().trim().min(1).max(50_000),
  category: campaignCategory,
});
export type CampaignContent = z.infer<typeof campaignContentSchema>;

export const emailTemplateInput = campaignContentSchema
  .extend({ name: z.string().trim().min(1).max(100) })
  .strict();
export const emailTemplateSchema = campaignContentSchema.extend({
  id: z.string(),
  name: z.string(),
  ...staffStamp,
});
export const emailTemplateBody = emailTemplateInput.extend({ expectedUpdatedAt }).strict();
export const emailTemplateListSchema = z.object({ items: z.array(emailTemplateSchema) });
export const emailTemplateDetailSchema = z.object({
  template: emailTemplateSchema,
  history: z.array(auditEntrySchema),
});
export const emailPreviewBody = campaignContentSchema
  .extend({
    /** Fill the variables from this account; placeholder values are used without one. */
    sampleUserId: id.optional(),
  })
  .strict();
export const emailPreviewSchema = z.object({
  subject: z.string(),
  html: z.string(),
  text: z.string(),
  /** What would stop the template from sending, such as an unknown variable. */
  problems: z.array(z.string()),
});
/** Sends the content to the signed-in staff member's own address. */
export const emailTestResultSchema = z.object({ sentTo: z.string() });

export const emailGroupInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).default(''),
  })
  .strict();
export const emailGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  memberCount: z.number(),
  ...staffStamp,
});
export const emailGroupBody = emailGroupInput.extend({ expectedUpdatedAt }).strict();
export const emailGroupListSchema = z.object({ items: z.array(emailGroupSchema) });
export const emailGroupDetailSchema = z.object({
  group: emailGroupSchema,
  history: z.array(auditEntrySchema),
});
export const emailGroupMemberSchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  addedAt: z.string(),
  addedBy: z.string(),
});
export const emailGroupMemberPageSchema = z.object({
  items: z.array(emailGroupMemberSchema),
  nextCursor: z.string().nullable(),
});
export const MAX_GROUP_ADD = 1000;
export const emailGroupAddBody = z
  .object({
    userIds: z.array(id).max(MAX_GROUP_ADD).default([]),
    /** Emails or usernames, e.g. pasted from a spreadsheet. */
    identifiers: z.array(z.string().trim().min(1).max(254)).max(MAX_GROUP_ADD).default([]),
  })
  .strict();
export const emailGroupAddResultSchema = z.object({
  group: emailGroupSchema,
  added: z.number(),
  alreadyMembers: z.number(),
  /** Identifiers that match no account; they were not added. */
  unmatched: z.array(z.string()),
});
export const emailGroupRemoveBody = z
  .object({ userIds: z.array(id).min(1).max(MAX_GROUP_ADD) })
  .strict();

export const campaignState = z.enum(['DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'STOPPED']);
export type CampaignState = z.infer<typeof campaignState>;
export const campaignAudienceSchema = z
  .object({
    groupIds: z.array(id).max(50).default([]),
    userIds: z.array(id).max(MAX_GROUP_ADD).default([]),
  })
  .strict();
export type CampaignAudience = z.infer<typeof campaignAudienceSchema>;
/** Why an account in the audience is not sent to. */
export const recipientSkipReason = z.enum([
  'NO_ACCOUNT',
  'DELETED',
  'SUSPENDED',
  'UNVERIFIED',
  'UNSUBSCRIBED',
  'SUPPRESSED',
  'STOPPED',
]);
export type RecipientSkipReason = z.infer<typeof recipientSkipReason>;
export const campaignCountsSchema = z.object({
  total: z.number(),
  pending: z.number(),
  sent: z.number(),
  skipped: z.number(),
  failed: z.number(),
});
export const campaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  templateId: z.string(),
  /** The template's current name, or the one sent if it has since been deleted. */
  templateName: z.string().nullable(),
  audience: campaignAudienceSchema,
  state: campaignState,
  /** When it was set to send; null for a draft. */
  scheduledAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  counts: campaignCountsSchema,
  /** The template as it was when the campaign was scheduled; later edits don't change it. */
  content: campaignContentSchema.nullable(),
  scheduledBy: z.string().nullable(),
  ...staffStamp,
});
export const campaignInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    templateId: id,
    audience: campaignAudienceSchema,
  })
  .strict();
export const campaignBody = campaignInput.extend({ expectedUpdatedAt }).strict();
export const campaignListSchema = z.object({ items: z.array(campaignSchema) });
export const campaignDetailSchema = z.object({
  campaign: campaignSchema,
  groups: z.array(z.object({ id: z.string(), name: z.string().nullable(), memberCount: z.number() })),
  users: z.array(z.object({ id: z.string(), email: z.string().nullable() })),
  history: z.array(auditEntrySchema),
});
export const campaignScheduleBody = z
  .object({
    /** When to start sending; null sends now. */
    at: z.iso.datetime({ offset: true }).nullable(),
    reason,
    expectedUpdatedAt,
  })
  .strict();
export const campaignReasonBody = z.object({ reason }).strict();
export const audienceCountBody = z
  .object({ audience: campaignAudienceSchema, category: campaignCategory })
  .strict();
export const audienceCountSchema = z.object({
  /** Distinct accounts across the groups and individual accounts. */
  total: z.number(),
  eligible: z.number(),
  skipped: z.partialRecord(recipientSkipReason, z.number()),
});
export const recipientStatus = z.enum(['PENDING', 'SENT', 'SKIPPED', 'FAILED']);
export const recipientSchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  status: recipientStatus,
  reason: recipientSkipReason.nullable(),
  error: z.string().nullable(),
  at: z.string().nullable(),
});
export const recipientPageSchema = z.object({
  items: z.array(recipientSchema),
  nextCursor: z.string().nullable(),
});
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;
export type EmailTemplateBody = z.infer<typeof emailTemplateBody>;
export type EmailTemplateDetail = z.infer<typeof emailTemplateDetailSchema>;
export type EmailPreviewBody = z.input<typeof emailPreviewBody>;
export type EmailPreview = z.infer<typeof emailPreviewSchema>;
export type EmailGroup = z.infer<typeof emailGroupSchema>;
export type EmailGroupBody = z.infer<typeof emailGroupBody>;
export type EmailGroupDetail = z.infer<typeof emailGroupDetailSchema>;
export type EmailGroupMember = z.infer<typeof emailGroupMemberSchema>;
export type EmailGroupMemberPage = z.infer<typeof emailGroupMemberPageSchema>;
export type EmailGroupAddResult = z.infer<typeof emailGroupAddResultSchema>;
export type Campaign = z.infer<typeof campaignSchema>;
export type CampaignBody = z.infer<typeof campaignBody>;
export type CampaignDetail = z.infer<typeof campaignDetailSchema>;
export type CampaignCounts = z.infer<typeof campaignCountsSchema>;
export type AudienceCount = z.infer<typeof audienceCountSchema>;
export type Recipient = z.infer<typeof recipientSchema>;
export type RecipientStatus = z.infer<typeof recipientStatus>;
export type RecipientPage = z.infer<typeof recipientPageSchema>;
