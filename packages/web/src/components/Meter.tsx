type Props = {
  readonly label: string;
  readonly used: number;
  readonly ceiling: number;
};

const format = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);

export const Meter = ({ label, used, ceiling }: Props) => {
  if (ceiling <= 0) return null;
  const ratio = Math.min(1, used / ceiling);
  const tone = ratio >= 0.9 ? "alert" : ratio >= 0.75 ? "warn" : "";
  return (
    <div className="meter">
      <div className="label">
        <span>{label}</span>
        <span>
          {format(used)} / {format(ceiling)}
        </span>
      </div>
      <div className="track">
        <div className={`fill ${tone}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
};
