import { cn } from "@/lib/utils";

const METHOD_TONE: Record<string, string> = {
  GET: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  POST: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  PATCH: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  DELETE: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

/** 端点标题：`POST /api/v1/activations` 这种一行式标识，全文档统一。 */
export function EndpointLine({
  method,
  path,
  id,
}: {
  method: string;
  path: string;
  id?: string;
}) {
  return (
    <div id={id} className="flex flex-wrap items-center gap-2">
      <span
        className={cn(
          "rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold",
          METHOD_TONE[method] ?? "bg-muted text-muted-foreground",
        )}
      >
        {method}
      </span>
      <code className="font-mono text-[13px] break-all">{path}</code>
    </div>
  );
}

export function ParamsTable({
  rows,
  caption,
}: {
  rows: Array<{ name: string; type: string; required?: boolean; description: string }>;
  caption?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-[13px]">
        {caption ? (
          <caption className="border-b border-border bg-muted/40 px-3 py-1.5 text-left text-[11px] font-medium text-muted-foreground">
            {caption}
          </caption>
        ) : null}
        <thead className="border-b border-border bg-muted/30">
          <tr>
            <th className="px-3 py-1.5 font-medium">字段</th>
            <th className="px-3 py-1.5 font-medium">类型</th>
            <th className="px-3 py-1.5 font-medium">必填</th>
            <th className="px-3 py-1.5 font-medium">说明</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-b border-border/60 last:border-0">
              <td className="px-3 py-1.5 font-mono text-[12px]">{row.name}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{row.type}</td>
              <td className="px-3 py-1.5">{row.required ? "是" : "否"}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{row.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 正文里的小节标题，保持与 h1 的层级差一致。 */
export function DocsSection({
  title,
  children,
  id,
}: {
  title: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="mt-10 scroll-mt-20">
      <h2 className="mb-3 text-lg font-semibold tracking-tight">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}
