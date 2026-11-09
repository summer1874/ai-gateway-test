import type { ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RollingNumber } from "@/components/ui/rolling-number";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TextureCard } from "@/components/ui/texture-card";
import { cn } from "@/lib/utils";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function NumberInput({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <Input
      type="number"
      className="tnum"
      value={Number.isNaN(value) ? "" : value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.valueAsNumber)}
    />
  );
}

export function Pick<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select items={options} value={value} disabled={disabled} onValueChange={(v) => v !== null && onChange(v as T)}>
      <SelectTrigger className={cn("w-full", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="tnum mt-0.5 truncate text-xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="tnum truncate text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Metric({
  label,
  value,
  format,
  precision = 0,
  sub,
  bad,
}: {
  label: string;
  value: number | null | undefined;
  format: (v: number) => string;
  precision?: number;
  sub?: string;
  bad?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className={cn("tnum mt-1 truncate text-2xl font-semibold tracking-tight", bad && "text-destructive")}>
        {value === null || value === undefined ? "—" : reduceMotion ? format(value) : <RollingNumber value={value} format={format} precision={precision} stiffness={140} damping={24} />}
      </div>
      <div className="tnum h-4 truncate text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

export interface SeriesDef {
  key: string;
  name: string;
  color: string;
}

interface TipPayload {
  dataKey?: unknown;
  value?: unknown;
  color?: string;
  name?: unknown;
}

function ChartTip({
  active,
  label,
  payload,
  xLabel,
  format,
}: {
  active?: boolean;
  label?: unknown;
  payload?: TipPayload[];
  xLabel: (x: unknown) => string;
  format: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <div className="mb-1 text-muted-foreground">{xLabel(label)}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span>{String(p.name)}</span>
          <span className="tnum ml-auto pl-3 font-medium">{typeof p.value === "number" ? format(p.value) : "—"}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ series }: { series: SeriesDef[] }) {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="h-0.5 w-3.5 rounded-full" style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

export function TimeChart<T extends object>({
  title,
  data,
  x,
  series,
  format,
  xLabel,
  height = 180,
  empty = "运行后显示",
}: {
  title: string;
  data: T[];
  x: string;
  series: SeriesDef[];
  format: (v: number) => string;
  xLabel: (x: unknown) => string;
  height?: number;
  empty?: string;
}) {
  return (
    <TextureCard className="min-w-0">
      <div className="p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <Legend series={series} />
      </div>
      {data.length === 0 ? (
        <div className="grid place-items-center text-xs text-muted-foreground" style={{ height }}>
          {empty}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
            <XAxis
              dataKey={x}
              tickLine={false}
              axisLine={{ stroke: "var(--viz-grid)" }}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              minTickGap={32}
            />
            <YAxis
              width={64}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickFormatter={(v: number) => format(v)}
            />
            <Tooltip
              cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "3 3" }}
              isAnimationActive={false}
              content={(p) => (
                <ChartTip
                  active={p.active}
                  label={p.label}
                  payload={p.payload as unknown as TipPayload[]}
                  xLabel={xLabel}
                  format={format}
                />
              )}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.name}
                stroke={s.color}
                strokeWidth={2}
                dot={data.length <= 40 ? { r: 2.5, strokeWidth: 0, fill: s.color } : false}
                activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
      </div>
    </TextureCard>
  );
}
