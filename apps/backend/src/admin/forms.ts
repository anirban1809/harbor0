import type { AuditEntry, Staff } from '../../../../packages/contracts/src/admin';
import type { formInput } from '../../../../packages/contracts/src/forms';
import type { z } from 'zod';
import { allRows } from '../campaigns';
import { assert } from '../errors';
import {
  FORM_PK,
  formProblems,
  formResponses,
  newFormId,
  responsePK,
  responseSK,
  type StoredForm,
  type StoredResponse,
} from '../forms';
import { formUrl } from '../emails';
import { Transaction, transact } from '../repository';
import type { AdminService } from './service';

const history = (id: string) => `ADMIN_AUDIT#FORM#${id}`;
type Fields = z.infer<typeof formInput>;
const stamp = (staff: Staff, row: { updatedAt: string }) => {
  const now = Date.now();
  const previous = Date.parse(row.updatedAt);
  return {
    updatedAt: new Date(previous >= now ? previous + 1 : now).toISOString(),
    updatedBy: staff.email,
  };
};
const getRow = async (tx: Transaction, id: string) => {
  const form = await tx.get<StoredForm>(FORM_PK, id);
  assert(form, 'NOT_FOUND', 'This form was not found.', 404);
  return form;
};

/** Forms as console staff manage them; every change is audited, also in the form's history. */
export class AdminForms {
  constructor(
    private admin: AdminService,
    private webOrigin: string,
  ) {}
  /** A form as the console sees it, with its share link. */
  private view = (form: StoredForm) => ({ ...form, link: formUrl(this.webOrigin, form.id) });
  private get repo() {
    return this.admin.repo;
  }
  private audit(tx: Transaction, staff: Staff, id: string, action: string, details: Record<string, unknown>) {
    return this.admin.audit(tx, staff, { action, details, scope: history(id) });
  }
  private check(fields: Fields) {
    const problems = formProblems(fields.questions);
    assert(!problems.length, 'INVALID_FORM', problems.join(' '), 400);
  }

  async list() {
    const items = await allRows<StoredForm>(this.repo, FORM_PK);
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items: items.map(this.view) };
  }
  async get(id: string) {
    const [form, log] = await Promise.all([
      getRow(new Transaction(this.repo), id),
      this.repo.query(history(id), '', 30),
    ]);
    return { form: this.view(form), history: log.rows.map((r) => r.data as AuditEntry) };
  }
  async create(staff: Staff, fields: Fields) {
    this.check(fields);
    const at = new Date().toISOString();
    const form: StoredForm = {
      id: newFormId(),
      ...fields,
      accepting: false,
      responseCount: 0,
      lastResponseAt: null,
      createdAt: at,
      createdBy: staff.email,
      updatedAt: at,
      updatedBy: staff.email,
    };
    await transact(this.repo, async (tx) => {
      await tx.put(FORM_PK, form.id, form);
      await this.audit(tx, staff, form.id, 'FORM_CREATED', { title: form.title });
    });
    return this.view(form);
  }
  async update(staff: Staff, id: string, fields: Fields, expectedUpdatedAt: string | null) {
    this.check(fields);
    return transact(this.repo, async (tx) => {
      const form = await getRow(tx, id);
      assert(
        form.updatedAt === expectedUpdatedAt,
        'CHANGED',
        `${form.updatedBy} changed this form since you opened it. Reload to see their change.`,
        409,
      );
      const next: StoredForm = { ...form, ...fields, ...stamp(staff, form) };
      await tx.put(FORM_PK, id, next);
      await this.audit(tx, staff, id, 'FORM_CHANGED', {
        title: next.title,
        changed: (['title', 'description', 'questions', 'audience', 'limit'] as const).filter(
          (k) => JSON.stringify(form[k]) !== JSON.stringify(next[k]),
        ),
      });
      return this.view(next);
    });
  }
  /** Starts or stops taking answers; the link keeps working and says when a form is closed. */
  async setAccepting(staff: Staff, id: string, accepting: boolean) {
    return transact(this.repo, async (tx) => {
      const form = await getRow(tx, id);
      if (form.accepting === accepting) return this.view(form);
      const next: StoredForm = { ...form, accepting, ...stamp(staff, form) };
      await tx.put(FORM_PK, id, next);
      await this.audit(tx, staff, id, accepting ? 'FORM_OPENED' : 'FORM_CLOSED', {
        title: form.title,
        responses: form.responseCount,
      });
      return this.view(next);
    });
  }
  /** Deletes the form and every response to it. */
  async delete(staff: Staff, id: string) {
    const form = await getRow(new Transaction(this.repo), id);
    const responses = await allRows<StoredResponse>(this.repo, responsePK(id), 'RESP#');
    // A transaction holds at most 100 items.
    for (let i = 0; i < responses.length; i += 90)
      await transact(this.repo, async (tx) => {
        for (const r of responses.slice(i, i + 90)) await tx.delete(responsePK(id), responseSK(r.id));
      });
    await transact(this.repo, async (tx) => {
      await tx.delete(FORM_PK, id);
      await this.audit(tx, staff, id, 'FORM_DELETED', {
        title: form.title,
        responses: responses.length,
      });
    });
    return { deleted: true };
  }
  responses(id: string) {
    return formResponses(this.repo, id);
  }
}
