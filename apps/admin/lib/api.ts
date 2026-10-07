import type {
    AdminBeta,
    AdminFlag,
    AdminFlagBody,
    AdminFlagDetail,
    AdminFlagList,
    AdminOverview,
    AdminPurgeResult,
    AdminUserDetail,
    AdminUserPage,
    AdminUserSort,
    AuditEntry,
    AuditPage,
    Staff,
    StaffDeletionReason,
    StaffLoginResult,
} from '../../../packages/contracts/src/admin';
import type { FlagUsagePage } from '../../../packages/contracts/src/flags';
import type {
    AudienceCount,
    Campaign,
    CampaignAudience,
    CampaignCategory,
    CampaignDetail,
    EmailGroup,
    EmailGroupAddResult,
    EmailGroupDetail,
    EmailGroupMemberPage,
    EmailPreview,
    EmailPreviewBody,
    EmailTemplate,
    EmailTemplateBody,
    EmailTemplateDetail,
    RecipientPage,
    RecipientStatus,
} from '../../../packages/contracts/src/campaigns';

export class ApiError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
    ) {
        super(message);
    }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
        response = await fetch(`/api/v1/admin${path}`, {
            method,
            credentials: 'same-origin',
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError(0, 'NETWORK', 'The console API is unreachable. Check your connection.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new ApiError(
            response.status,
            data.error?.code ?? 'UNKNOWN',
            data.error?.message ?? 'The request failed.',
        );
    return data as T;
}

const user = (id: string) => `/users/${encodeURIComponent(id)}`;
const flag = (key: string) => `/flags/${encodeURIComponent(key)}`;
const email = (kind: 'templates' | 'groups' | 'campaigns', id: string) =>
    `/email/${kind}/${encodeURIComponent(id)}`;
export const api = {
    login: (email: string, password: string) =>
        request<StaffLoginResult>('POST', '/auth/login', { email, password }),
    challenge: (input: {
        email: string;
        session: string;
        challenge: 'NEW_PASSWORD' | 'MFA_SETUP' | 'MFA';
        newPassword?: string;
        code?: string;
    }) => request<StaffLoginResult>('POST', '/auth/challenge', input),
    logout: () => request<{ signedOut: boolean; }>('POST', '/auth/logout', {}),
    me: () => request<{ staff: Staff; }>('GET', '/me'),
    overview: (refresh = false) =>
        request<AdminOverview>('GET', `/overview${refresh ? '?refresh=1' : ''}`),
    beta: () => request<AdminBeta>('GET', '/beta'),
    openWave: (cap: number, reason: string) =>
        request<AdminBeta & { newlyInvited: number; }>('POST', '/beta/wave', { cap, reason }),
    purgeDeletedAccounts: (reason: string) =>
        request<AdminPurgeResult>('POST', '/deleted-accounts/purge', { reason }),
    audit: (cursor?: string) =>
        request<AuditPage>('GET', `/audit${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    users: (q: string, sort: AdminUserSort | null, cursor?: string) =>
        request<AdminUserPage>(
            'GET',
            `/users?${new URLSearchParams({ q, ...(sort ?? {}), ...(cursor ? { cursor } : {}) })}`,
        ),
    user: (id: string) => request<AdminUserDetail>('GET', user(id)),
    setQuota: (id: string, quotaBytes: number, reason: string) =>
        request('PUT', `${user(id)}/quota`, { quotaBytes, reason }),
    action: (id: string, action: UserAction, reason: string) =>
        request('POST', `${user(id)}/${action}`, { reason }),
    signOutDevice: (id: string, deviceId: string, reason: string) =>
        request('POST', `${user(id)}/devices/${encodeURIComponent(deviceId)}/sign-out`, { reason }),
    note: (id: string, text: string) => request<AuditEntry>('POST', `${user(id)}/notes`, { text }),
    deleteAccount: (
        id: string,
        confirmEmail: string,
        reason: string,
        category: StaffDeletionReason,
        notify: boolean,
    ) =>
        request<{ deleted: boolean; purgeAt: string | null; }>('POST', `${user(id)}/delete`, {
            confirmEmail,
            reason,
            category,
            notify,
        }),
    flags: () => request<AdminFlagList>('GET', '/flags'),
    flag: (key: string) => request<AdminFlagDetail>('GET', flag(key)),
    flagUsage: (key: string, cursor?: string) =>
        request<FlagUsagePage>(
            'GET',
            `${flag(key)}/usage${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
    saveFlag: (key: string, body: AdminFlagBody) => request<AdminFlag>('PUT', flag(key), body),
    addFlagUser: (key: string, userId: string, reason: string) =>
        request<AdminFlag>('POST', `${flag(key)}/users`, { userId, reason }),
    removeFlagUser: (key: string, userId: string, reason: string) =>
        request<AdminFlag>(
            'POST',
            `${flag(key)}/users/${encodeURIComponent(userId)}/remove`,
            { reason },
        ),
    // Email campaigns
    templates: () => request<{ items: EmailTemplate[]; }>('GET', '/email/templates'),
    template: (id: string) => request<EmailTemplateDetail>('GET', email('templates', id)),
    createTemplate: (body: Omit<EmailTemplateBody, 'expectedUpdatedAt'>) =>
        request<EmailTemplate>('POST', '/email/templates', body),
    saveTemplate: (id: string, body: EmailTemplateBody) =>
        request<EmailTemplate>('PUT', email('templates', id), body),
    deleteTemplate: (id: string) => request<{ deleted: boolean; }>('DELETE', email('templates', id)),
    preview: (body: EmailPreviewBody) => request<EmailPreview>('POST', '/email/preview', body),
    sendTest: (body: EmailPreviewBody) => request<{ sentTo: string; }>('POST', '/email/test', body),
    groups: () => request<{ items: EmailGroup[]; }>('GET', '/email/groups'),
    group: (id: string) => request<EmailGroupDetail>('GET', email('groups', id)),
    createGroup: (name: string, description: string) =>
        request<EmailGroup>('POST', '/email/groups', { name, description }),
    saveGroup: (id: string, name: string, description: string, expectedUpdatedAt: string) =>
        request<EmailGroup>('PUT', email('groups', id), { name, description, expectedUpdatedAt }),
    deleteGroup: (id: string) => request<{ deleted: boolean; }>('DELETE', email('groups', id)),
    groupMembers: (id: string, cursor?: string) =>
        request<EmailGroupMemberPage>(
            'GET',
            `${email('groups', id)}/members${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
    addGroupMembers: (id: string, body: { userIds?: string[]; identifiers?: string[]; }) =>
        request<EmailGroupAddResult>('POST', `${email('groups', id)}/members`, body),
    removeGroupMembers: (id: string, userIds: string[]) =>
        request<{ group: EmailGroup; removed: number; }>(
            'POST',
            `${email('groups', id)}/members/remove`,
            { userIds },
        ),
    audienceCount: (audience: CampaignAudience, category: CampaignCategory) =>
        request<AudienceCount>('POST', '/email/audience/count', { audience, category }),
    campaigns: () => request<{ items: Campaign[]; }>('GET', '/email/campaigns'),
    campaign: (id: string) => request<CampaignDetail>('GET', email('campaigns', id)),
    createCampaign: (body: { name: string; templateId: string; audience: CampaignAudience; }) =>
        request<Campaign>('POST', '/email/campaigns', body),
    saveCampaign: (
        id: string,
        body: { name: string; templateId: string; audience: CampaignAudience; expectedUpdatedAt: string; },
    ) => request<Campaign>('PUT', email('campaigns', id), body),
    deleteCampaign: (id: string) => request<{ deleted: boolean; }>('DELETE', email('campaigns', id)),
    scheduleCampaign: (id: string, at: string | null, reason: string, expectedUpdatedAt: string) =>
        request<Campaign>('POST', `${email('campaigns', id)}/schedule`, {
            at,
            reason,
            expectedUpdatedAt,
        }),
    cancelCampaign: (id: string, reason: string) =>
        request<Campaign>('POST', `${email('campaigns', id)}/cancel`, { reason }),
    stopCampaign: (id: string, reason: string) =>
        request<Campaign>('POST', `${email('campaigns', id)}/stop`, { reason }),
    recipients: (id: string, status?: RecipientStatus, cursor?: string) =>
        request<RecipientPage>(
            'GET',
            `${email('campaigns', id)}/recipients?${new URLSearchParams({
                ...(status ? { status } : {}),
                ...(cursor ? { cursor } : {}),
            })}`,
        ),
};
export type UserAction =
    | 'password-reset'
    | 'verification/resend'
    | 'verification/confirm'
    | 'sign-out'
    | 'suspend'
    | 'unsuspend';
