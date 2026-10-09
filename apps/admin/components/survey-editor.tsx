'use client';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import {
  MAX_SURVEY_OPTIONS,
  MAX_SURVEY_QUESTIONS,
  type Survey,
  type SurveyQuestion,
  type SurveyQuestionKind,
} from '../../../packages/contracts/src/campaigns';
import { Button } from '../../web/components/ui/button';
import { Checkbox } from '../../web/components/ui/checkbox';
import { Field } from '../../web/components/ui/field';
import { Input } from '../../web/components/ui/input';
import { Segmented } from '../../web/components/ui/segmented';
import { Select } from '../../web/components/ui/select';

export const surveyKinds: Record<SurveyQuestionKind, string> = {
  RATING: 'Rating',
  CHOICE: 'One choice',
  MULTI: 'Several choices',
  TEXT: 'Written answer',
};
const newId = () => Math.random().toString(36).slice(2, 10) || 'q';
const blankQuestion = (kind: SurveyQuestionKind = 'RATING'): SurveyQuestion => ({
  id: newId(),
  kind,
  prompt: '',
  options: kind === 'CHOICE' || kind === 'MULTI' ? ['', ''] : [],
  scale: 5,
  required: false,
});

/**
 * The survey as the backend takes it: choices trimmed, blank ones dropped, and fields a
 * question's kind doesn't use cleared. Questions without a prompt are left out of a preview;
 * saving refuses them (see surveyIssue).
 */
export function cleanSurvey(survey: Survey | null, forPreview = false): Survey | null {
  if (!survey) return null;
  const questions = survey.questions
    .map((q) => ({
      ...q,
      prompt: q.prompt.trim(),
      options:
        q.kind === 'CHOICE' || q.kind === 'MULTI'
          ? q.options.map((o) => o.trim()).filter(Boolean)
          : [],
    }))
    .filter((q) => !forPreview || q.prompt);
  return questions.length ? { questions } : null;
}

/** What stops the survey from being saved, if anything. */
export function surveyIssue(survey: Survey | null) {
  if (!survey) return '';
  if (!survey.questions.length) return 'Add a question to the survey, or remove it.';
  const blank = survey.questions.findIndex((q) => !q.prompt.trim());
  if (blank >= 0) return `Survey question ${blank + 1} needs its question.`;
  const few = survey.questions.findIndex(
    (q) => (q.kind === 'CHOICE' || q.kind === 'MULTI') && q.options.filter((o) => o.trim()).length < 2,
  );
  if (few >= 0) return `Survey question ${few + 1} needs at least two choices.`;
  return '';
}

export function SurveyEditor({
  value,
  disabled,
  onChange,
}: {
  value: Survey | null;
  disabled: boolean;
  onChange: (survey: Survey | null) => void;
}) {
  if (!value)
    return (
      <div className="admin-survey-empty">
        <p className="admin-muted">
          Ask a few questions in the email. A rating or one-choice first question is answered with
          one click in the email; the rest are on a short page it opens.
        </p>
        {!disabled && (
          <Button variant="outline" onClick={() => onChange({ questions: [blankQuestion()] })}>
            <Plus aria-hidden="true" />
            Add a survey
          </Button>
        )}
      </div>
    );
  const questions = value.questions;
  const update = (index: number, change: Partial<SurveyQuestion>) =>
    onChange({ questions: questions.map((q, i) => (i === index ? { ...q, ...change } : q)) });
  const move = (index: number, by: number) => {
    const next = [...questions];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    onChange({ questions: next });
  };
  return (
    <div className="admin-survey">
      <p className="admin-muted">
        Goes at the end of the message, or where a line says <code>{'{{survey}}'}</code>. Answers
        are kept with each recipient’s email and shown on the campaign.
      </p>
      {questions.map((q, i) => (
        <fieldset key={q.id} className="admin-survey-question" disabled={disabled}>
          <div className="admin-survey-question-bar">
            <strong>Question {i + 1}</strong>
            {i === 0 && (q.kind === 'RATING' || q.kind === 'CHOICE') && (
              <span className="admin-muted">One click in the email</span>
            )}
            <span className="admin-survey-tools">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Move up"
                disabled={disabled || i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Move down"
                disabled={disabled || i === questions.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove question"
                disabled={disabled}
                onClick={() =>
                  onChange(
                    questions.length > 1 ? { questions: questions.filter((_, j) => j !== i) } : null,
                  )
                }
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </span>
          </div>
          <div className="admin-survey-row">
            <Field label="Kind">
              <Select
                value={q.kind}
                onChange={(e) => {
                  const kind = e.target.value as SurveyQuestionKind;
                  const choices = kind === 'CHOICE' || kind === 'MULTI';
                  update(i, {
                    kind,
                    options: choices ? (q.options.length ? q.options : ['', '']) : q.options,
                  });
                }}
              >
                {Object.entries(surveyKinds).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Question">
              <Input
                value={q.prompt}
                maxLength={300}
                autoFocus={i > 0 && !q.prompt}
                placeholder={
                  q.kind === 'RATING'
                    ? 'How would you rate harbor0 so far?'
                    : q.kind === 'TEXT'
                      ? 'What should we build next?'
                      : 'Which apps do you use?'
                }
                onChange={(e) => update(i, { prompt: e.target.value })}
              />
            </Field>
          </div>
          {q.kind === 'RATING' && (
            <Segmented<'5' | '10'>
              label="Scale"
              value={String(q.scale) as '5' | '10'}
              disabled={disabled}
              onValueChange={(v) => update(i, { scale: v === '10' ? 10 : 5 })}
              options={[
                { value: '5', label: '1 to 5' },
                { value: '10', label: '0 to 10 (NPS)' },
              ]}
            />
          )}
          {(q.kind === 'CHOICE' || q.kind === 'MULTI') && (
            <div className="admin-survey-options">
              {q.options.map((option, j) => (
                <div key={j} className="admin-survey-option">
                  <Input
                    aria-label={`Choice ${j + 1}`}
                    placeholder={`Choice ${j + 1}`}
                    // A choice added with the button below takes the cursor.
                    autoFocus={j >= 2 && j === q.options.length - 1 && !option}
                    value={option}
                    maxLength={100}
                    onChange={(e) =>
                      update(i, { options: q.options.map((o, k) => (k === j ? e.target.value : o)) })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove choice ${j + 1}`}
                    disabled={disabled || q.options.length <= 2}
                    onClick={() => update(i, { options: q.options.filter((_, k) => k !== j) })}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
              ))}
              {q.options.length < MAX_SURVEY_OPTIONS && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => update(i, { options: [...q.options, ''] })}
                >
                  <Plus aria-hidden="true" />
                  Add a choice
                </Button>
              )}
            </div>
          )}
          <Field label="Required" inline>
            <Checkbox checked={q.required} onChange={(e) => update(i, { required: e.target.checked })} />
          </Field>
        </fieldset>
      ))}
      {!disabled && (
        <div className="admin-actions">
          {questions.length < MAX_SURVEY_QUESTIONS && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange({ questions: [...questions, blankQuestion('TEXT')] })}
            >
              <Plus aria-hidden="true" />
              Add a question
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Remove the survey
          </Button>
        </div>
      )}
    </div>
  );
}
