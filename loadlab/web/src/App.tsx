import { useEffect, useMemo, useState } from "react";
import { Gauge, MessagesSquare, Waypoints, type LucideIcon } from "lucide-react";
import { ChatTab } from "@/components/ChatTab";
import { LoadTab } from "@/components/LoadTab";
import { TraceTab } from "@/components/TraceTab";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, useLive, type Meta } from "@/lib/api";

type Page = "load" | "trace" | "chat";

const NAV: { id: Page; title: string; desc: string; icon: LucideIcon }[] = [
  { id: "load", title: "压测", desc: "配置负载，实时观察吞吐、延迟与错误", icon: Gauge },
  { id: "trace", title: "请求链路", desc: "逐条查看请求的瀑布图与各阶段耗时", icon: Waypoints },
  { id: "chat", title: "长对话", desc: "用真实 key 跑完整对话并校验上下文", icon: MessagesSquare },
];

function AppSidebar({
  page,
  onNavigate,
  connected,
  busy,
}: {
  page: Page;
  onNavigate: (p: Page) => void;
  connected: boolean;
  busy: Partial<Record<Page, boolean>>;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex h-10 items-center gap-2.5 overflow-hidden px-1 group-data-[collapsible=icon]:px-0">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Gauge className="size-4" />
          </span>
          <span className="grid min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold">网关压测台</span>
            <span className="truncate text-[11px] text-sidebar-foreground/60">LoadLab</span>
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>工作台</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((n) => (
                <SidebarMenuItem key={n.id}>
                  <SidebarMenuButton
                    isActive={page === n.id}
                    tooltip={n.title}
                    onClick={() => {
                      onNavigate(n.id);
                      setOpenMobile(false);
                    }}
                  >
                    <n.icon />
                    <span>{n.title}</span>
                  </SidebarMenuButton>
                  {busy[n.id] && (
                    <SidebarMenuBadge>
                      <span className="size-1.5 animate-pulse rounded-full" style={{ background: "var(--viz-good)" }} />
                      <span className="ml-1.5 text-[11px]">运行中</span>
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div
          className="flex items-center gap-2 px-2 py-1.5 text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
          title={connected ? "已连接" : "连接中断"}
        >
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: connected ? "var(--viz-good)" : "var(--viz-bad)" }} />
          <span className="group-data-[collapsible=icon]:hidden">{connected ? "已连接" : "连接中断"}</span>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export default function App() {
  const { run, chat, streaming, connected } = useLive();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [page, setPage] = useState<Page>("load");
  const [focus, setFocus] = useState<{ run: string | null; trace: string | null }>({ run: null, trace: null });

  useEffect(() => {
    api<Meta>("/meta").then(setMeta).catch(() => undefined);
  }, []);

  const runIds = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    if (run) out.push({ value: run.runId, label: "最近压测" });
    if (chat) out.push({ value: chat.chatId, label: "最近长对话" });
    return out;
  }, [run, chat]);

  const live = run?.state === "running" || chat?.state === "running";
  const current = NAV.find((n) => n.id === page)!;

  function navigate(p: Page) {
    setPage(p);
    window.scrollTo(0, 0);
  }

  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={!document.cookie.includes("sidebar_state=false")}>
        <AppSidebar
          page={page}
          onNavigate={navigate}
          connected={connected}
          busy={{ load: !!run && run.state !== "finished", chat: chat?.state === "running" }}
        />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur sm:px-5">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center" />
            <h1 className="shrink-0 text-sm font-semibold tracking-tight">{current.title}</h1>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">{current.desc}</p>
          </header>

          <div className="mx-auto w-full max-w-[1600px] p-4 sm:p-5">
            {page === "load" && (
              <LoadTab
                run={run}
                meta={meta}
                onOpenTraces={(runId) => {
                  setFocus({ run: runId, trace: null });
                  navigate("trace");
                }}
              />
            )}
            {page === "trace" && <TraceTab runIds={runIds} focusRun={focus.run} focusTrace={focus.trace} live={!!live} />}
            {page === "chat" && (
              <ChatTab
                chat={chat}
                streaming={streaming}
                meta={meta}
                onOpenTrace={(runId, traceId) => {
                  setFocus({ run: runId, trace: traceId });
                  navigate("trace");
                }}
              />
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
