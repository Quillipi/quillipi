/**
 * Agents: how to connect Claude, the AI instructions for every notebook (step 3.4c), the apps
 * connected now (each with when it connected, and Disconnect), and which notebook tools use when a
 * chat names none. Each agent's recent work and its mode come later. Laid out like Home: the top
 * bar says how many apps are connected, and each part is a card on the page.
 */
import type { AgentConnection } from '@inklog/core';
import { PencilLine, ShieldCheck } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Problem } from '../App';
import { api } from '../api';
import { ConnectClaude } from '../components/ConnectClaude';
import { Instructions } from '../dialogs/Instructions';
import { Band, TopBar } from '../frame/TopBar';
import { cn } from '../lib/cn';
import { loadHome, useShelf } from '../store';
import { Button } from '../ui/Button';
import { AgentMark, Ago } from '../ui/Marks';
import { CELL, Context, ROW, Table } from './Home';

export function Agents() {
  const [connections, setConnections] = useState<AgentConnection[]>();
  const [error, setError] = useState<Error>();
  const [failure, setFailure] = useState<string>();
  const [asking, setAsking] = useState<string>();
  const [instructing, setInstructing] = useState(false);
  const [shared, setShared] = useState<{ text: string; tokens: number }>();
  const cards = useShelf((state) => state.cards);
  const fallback = useShelf((state) => state.default);
  const load = () => void api.agents().then(({ connections: found }) => setConnections(found), setError);

  useEffect(load, []);
  // The default notebook comes with Home's data.
  useEffect(() => {
    loadHome().catch(setError);
  }, []);
  useEffect(() => {
    if (!instructing) void api.sharedInstructions().then(setShared, () => setShared(undefined));
  }, [instructing]);

  if (error) return <Problem error={error} />;
  const notebooks = cards.filter((card) => !card.archived);
  const chosen = fallback ?? [...notebooks].sort((a, b) => a.createdAt - b.createdAt)[0]?.id;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <TopBar>
        <Context
          art="/3d/sparkles_3d.png"
          title="Agents"
          figure={
            connections && (
              <>
                <strong>{connections.length}</strong> {connections.length === 1 ? 'app' : 'apps'} connected
              </>
            )
          }
        >
          <p className="truncate text-[12.5px] text-muted-foreground max-md:hidden">Claude reads and writes your notebooks through Quillipi</p>
        </Context>
      </TopBar>
      <Band>
        <nav aria-label="Where you are" className="text-[14px] font-medium">
          <span aria-current="page">Agents</span>
        </nav>
      </Band>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[860px] flex-col gap-5 px-6 py-7 max-md:px-4 max-md:py-5">
          <Card title="Connect Claude" text="Claude then reads and writes your notebooks from any chat, on the phone and in Claude Code, with your laptop off.">
            <ConnectClaude />
          </Card>

          <Card
            title="AI instructions for every notebook"
            text="Your way of working, such as “write completely and correctly”. Every AI gets them at the start of every chat, before a notebook’s own instructions, so you don’t have to say them again."
            action={
              <Button onClick={() => setInstructing(true)}>
                <PencilLine className="size-4" aria-hidden="true" /> {shared?.text ? 'Edit' : 'Write them'}
              </Button>
            }
          >
            {shared?.text ? (
              <pre className="scroll-quiet max-h-40 overflow-auto rounded-xl border border-border bg-surface px-3.5 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">{shared.text}</pre>
            ) : (
              <p className="rounded-xl border border-dashed border-input bg-surface px-3.5 py-3 text-[13.5px] text-muted-foreground">None yet. An AI gets only each notebook’s own instructions.</p>
            )}
            <p className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <ShieldCheck className="size-3.5 text-added" aria-hidden="true" />
              Only you change these, here. No AI tool can.
              {shared?.text ? ` About ${shared.tokens.toLocaleString()} tokens in every chat.` : ''}
            </p>
          </Card>

          <Card title="Connected apps">
            {!connections ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : connections.length ? (
              <Table head={['App', 'Connected', '']} hide={[]}>
                {connections.map((connection) => (
                  <tr key={connection.id} className={ROW}>
                    <td className={cn(CELL, 'pl-3')}>
                      <span className="flex items-center gap-3">
                        <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-agent-soft text-[15px]">
                          <AgentMark label="" />
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium text-agent">{connection.app}</span>
                          <span className="truncate text-[12.5px] text-muted-foreground">Its changes are marked ✦ and committed with its name</span>
                        </span>
                      </span>
                    </td>
                    <td className={cn(CELL, 'whitespace-nowrap text-muted-foreground')}>
                      <Ago at={connection.since} />
                    </td>
                    <td className={cn(CELL, 'pr-3 text-right')}>
                      {asking === connection.id ? (
                        <span className="relative z-10 inline-flex gap-1.5">
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              setAsking(undefined);
                              void api.disconnectAgent(connection.id).then(load, (problem: Error) => setFailure(problem.message));
                            }}
                          >
                            Disconnect
                          </Button>
                          <Button size="sm" onClick={() => setAsking(undefined)}>
                            Keep
                          </Button>
                        </span>
                      ) : (
                        <Button size="sm" className="relative z-10" title="It will have to sign in again to use your notebooks" onClick={() => setAsking(connection.id)}>
                          Disconnect
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            ) : (
              <p className="text-[13.5px] text-muted-foreground">No apps are connected yet.</p>
            )}
            {failure && (
              <p className="mt-2 text-[13px] text-removed" role="alert">
                {failure}
              </p>
            )}
          </Card>

          {notebooks.length > 0 && (
            <Card title="The notebook Claude uses when a chat names none" text="A chat can always name a notebook. This one is used when it doesn’t; new chats are told which it is.">
              <select
                aria-label="The notebook Claude uses when a chat names none"
                value={chosen}
                onChange={(event) => {
                  const id = event.target.value;
                  void api.setDefault(id).then(() => useShelf.setState({ default: id }), (problem: Error) => setFailure(problem.message));
                }}
                className="h-10 w-full max-w-sm cursor-pointer rounded-xl border border-input bg-background px-3 text-[14px] outline-none transition-[border-color,box-shadow] focus:border-brand focus:ring-[3px] focus:ring-brand/15 touch:h-11 touch:text-[16px]"
              >
                {notebooks.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.title}
                  </option>
                ))}
              </select>
            </Card>
          )}
        </div>
      </div>
      {instructing && <Instructions scope="shared" onClose={() => setInstructing(false)} />}
    </main>
  );
}

function Card({ title, text, action, children }: { title: string; text?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl border border-border bg-background p-5 shadow-[0_1px_2px_rgb(27_24_38/4%)] max-md:p-4">
      <div className="mb-3.5 flex items-start gap-4 max-sm:flex-col max-sm:gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{title}</h2>
          {text && <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">{text}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
