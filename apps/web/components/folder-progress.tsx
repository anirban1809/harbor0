import { RefreshCw } from 'lucide-react';

/** Percent complete of a folder's sync or backup, as a thin bar with its figure. */
export function FolderProgress({
    percent,
    label,
    showValue = true,
}: {
    percent: number;
    label: string;
    showValue?: boolean;
}) {
    return (
        <div className="folder-progress">
            <div
                className="progress-track"
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
            >
                <span style={{ width: `${percent}%` }} />
            </div>
            {showValue && <span className="folder-progress-value">{percent}%</span>}
        </div>
    );
}

/** Shown on top of a folder while its sync or backup is under way. */
export function FolderProgressBanner({
    percent,
    title,
    detail,
}: {
    percent: number;
    title: string;
    detail: string;
}) {
    return (
        <section className="card status-card folder-progress-banner" role="status" aria-label={title}>
            <div className="status-card-heading">
                <RefreshCw className="spin" size={18} aria-hidden="true" />
                <strong title={title}>{title}</strong>
                <span className="folder-progress-value">{percent}%</span>
            </div>
            <div className="status-card-details">
                <span>{detail}</span>
            </div>
            <FolderProgress percent={percent} label={`${title} progress`} showValue={false} />
        </section>
    );
}
