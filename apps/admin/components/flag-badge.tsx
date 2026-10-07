import type { FlagMode } from '../../../packages/contracts/src/flags';
import { Badge, type BadgeTone } from '../../web/components/ui/badge';
import { flagModeLabels } from '../lib/format';

const tones: Record<FlagMode, BadgeTone> = { OFF: 'neutral', TARGETED: 'warning', ON: 'success' };
export function FlagModeBadge({ mode }: { mode: FlagMode }) {
  return <Badge tone={tones[mode]}>{flagModeLabels[mode]}</Badge>;
}
