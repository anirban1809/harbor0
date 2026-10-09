'use client';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import {
  MAX_FORM_OPTIONS,
  MAX_FORM_QUESTIONS,
  type FormQuestion,
  type FormQuestionKind,
} from '../../../packages/contracts/src/forms';
import { Button } from '../../web/components/ui/button';
import { Checkbox } from '../../web/components/ui/checkbox';
import { Field } from '../../web/components/ui/field';
import { Input } from '../../web/components/ui/input';
import { Segmented } from '../../web/components/ui/segmented';
import { Select } from '../../web/components/ui/select';

export const questionKinds: Record<FormQuestionKind, string> = {
  RATING: 'Rating',
  CHOICE: 'One choice',
  MULTI: 'Several choices',
  TEXT: 'Written answer',
};
const newId = () => Math.random().toString(36).slice(2, 10) || 'q';
const blankQuestion = (kind: FormQuestionKind = 'RATING'): FormQuestion => ({
  id: newId(),
  kind,
  prompt: '',
  options: kind === 'CHOICE' || kind === 'MULTI' ? ['', ''] : [],
  scale: 5,
  required: false,
});

export const blankQuestions = () => [blankQuestion()];

/**
 * The questions as the backend takes them: choices trimmed, blank ones dropped, and fields a
 * question's kind doesn't use cleared.
 */
export function cleanQuestions(questions: FormQuestion[]): FormQuestion[] {
  return questions.map((q) => ({
    ...q,
    prompt: q.prompt.trim(),
    options:
      q.kind === 'CHOICE' || q.kind === 'MULTI' ? q.options.map((o) => o.trim()).filter(Boolean) : [],
  }));
}

/** What stops the questions from being saved, if anything. */
export function questionsIssue(questions: FormQuestion[]) {
  if (!questions.length) return 'Add a question.';
  const blank = questions.findIndex((q) => !q.prompt.trim());
  if (blank >= 0) return `Question ${blank + 1} needs its question.`;
  const few = questions.findIndex(
    (q) => (q.kind === 'CHOICE' || q.kind === 'MULTI') && q.options.filter((o) => o.trim()).length < 2,
  );
  if (few >= 0) return `Question ${few + 1} needs at least two choices.`;
  return '';
}

/** Builds a form's questions: kind, wording, choices or scale, and whether each is required. */
export function QuestionsEditor({
  value: questions,
  disabled,
  onChange,
}: {
  value: FormQuestion[];
  disabled: boolean;
  onChange: (questions: FormQuestion[]) => void;
}) {
  const update = (index: number, change: Partial<FormQuestion>) =>
    onChange(questions.map((q, i) => (i === index ? { ...q, ...change } : q)));
  const move = (index: number, by: number) => {
    const next = [...questions];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    onChange(next);
  };
  return (
    <div className="admin-survey">
      {questions.map((q, i) => (
        <fieldset key={q.id} className="admin-survey-question" disabled={disabled}>
          <div className="admin-survey-question-bar">
            <strong>Question {i + 1}</strong>
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
                disabled={disabled || questions.length === 1}
                onClick={() => onChange(questions.filter((_, j) => j !== i))}
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
                  const kind = e.target.value as FormQuestionKind;
                  const choices = kind === 'CHOICE' || kind === 'MULTI';
                  update(i, {
                    kind,
                    options: choices ? (q.options.length ? q.options : ['', '']) : q.options,
                  });
                }}
              >
                {Object.entries(questionKinds).map(([kind, label]) => (
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
              {q.options.length < MAX_FORM_OPTIONS && (
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
          {questions.length < MAX_FORM_QUESTIONS && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange([...questions, blankQuestion('TEXT')])}
            >
              <Plus aria-hidden="true" />
              Add a question
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
