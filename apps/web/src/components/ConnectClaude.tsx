/**
 * How to connect Claude to this Quillipi: its address to copy, with the steps for each place Claude
 * runs, as tabs in a track like Home's. Used by Home's Get started card and the Agents page.
 */
import { Tabs } from 'radix-ui';
import type { ReactNode } from 'react';
import { CopyLine } from '../pages/Overview';

const TAB =
  'flex h-8 shrink-0 items-center rounded-[9px] px-3 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-tile touch:h-10';

export function ConnectClaude() {
  const address = `${location.origin}/mcp`;
  return (
    <Tabs.Root defaultValue="claude-ai">
      <Tabs.List aria-label="Where you use Claude" className="no-scrollbar flex max-w-full gap-0.5 overflow-x-auto rounded-xl bg-secondary p-1 sm:w-fit">
        <Tabs.Trigger value="claude-ai" className={TAB}>
          claude.ai and phone
        </Tabs.Trigger>
        <Tabs.Trigger value="code" className={TAB}>
          Claude Code
        </Tabs.Trigger>
        <Tabs.Trigger value="desktop" className={TAB}>
          Claude Desktop
        </Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="claude-ai" className="mt-3.5 outline-none">
        <Steps>
          <Step n={1}>
            In Claude, open <b>Settings</b>, then <b>Connectors</b>, and choose <b>Add custom connector</b>.
          </Step>
          <Step n={2}>
            Name it <b>Quillipi</b> and paste this address:
            <CopyLine text={address} className="mt-2" />
          </Step>
          <Step n={3}>
            Press <b>Add</b>, then <b>Connect</b>, and <b>Continue with GitHub</b>.
          </Step>
        </Steps>
        <Note>The Claude app on your phone uses the same connector, through your Claude account. In a chat, turn Quillipi on from the + menu.</Note>
      </Tabs.Content>

      <Tabs.Content value="code" className="mt-3.5 outline-none">
        <Steps>
          <Step n={1}>
            Run this in a terminal:
            <CopyLine text={`claude mcp add --transport http --scope user quillipi ${address}`} className="mt-2" />
          </Step>
          <Step n={2}>
            Start Claude Code, type <code className="font-mono text-[12.5px]">/mcp</code>, choose <b>quillipi</b> and <b>Authenticate</b>, then <b>Continue with GitHub</b>.
          </Step>
        </Steps>
      </Tabs.Content>

      <Tabs.Content value="desktop" className="mt-3.5 outline-none">
        <p className="text-[13.5px] leading-relaxed text-foreground/85">
          Claude Desktop uses the connectors of your Claude account. Add Quillipi once on claude.ai (the first tab), and it is in Claude Desktop too, and on your phone.
        </p>
      </Tabs.Content>
    </Tabs.Root>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col gap-3">{children}</ol>;
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-[13.5px] leading-relaxed text-foreground/85 [&_b]:font-semibold [&_b]:text-foreground">
      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-brand-soft text-[11.5px] font-semibold text-brand" aria-hidden="true">
        {n}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">{children}</p>;
}
