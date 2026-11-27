import type { AiShowcaseProps, SiteRenderContext } from "@/components/site/blocks/types";
import { AiChat } from "@/components/site/blocks/ai-chat";
import { anchorId, fill } from "@/components/site/links";
import { Reveal } from "@/components/site/motion";
import { Container } from "@/components/site/ui";

/**
 * {siteName} AI answering questions about a business (owner, 18 Nov 2026 — the new home page): a dark band, the words
 * on the left with the questions as chips, the answer typed out in a chat on the right. Sample answers, written in the
 * CMS; the typing is AiChat's.
 */
export function AiShowcaseBlock({ props, ctx }: { props: AiShowcaseProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const questions = props.questions.filter((q) => q.question && q.answer).map((q) => ({ question: t(q.question), answer: t(q.answer) }));
  if (!questions.length) return null;
  const eyebrow = t(props.eyebrow);
  const intro = t(props.intro);
  const note = t(props.note);
  return (
    <section id={anchorId(props.anchor)} className="site-night relative isolate scroll-mt-20 overflow-hidden py-20 sm:py-32">
      <div aria-hidden="true" className="site-aurora opacity-35">
        <i />
        <i />
        <i />
      </div>
      <Container className="relative">
        <AiChat
          questions={questions}
          head={
            <Reveal>
              {eyebrow && (
                <p className="inline-flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.1em] text-[#c6f432]">
                  <span aria-hidden="true" className="h-0.5 w-4 bg-current" />
                  {eyebrow}
                </p>
              )}
              <h2 className="mt-3 text-4xl font-semibold leading-[1.04] tracking-[-0.04em] text-white text-balance sm:text-6xl">{t(props.heading)}</h2>
              {intro && <p className="mt-5 max-w-xl text-base leading-7 text-white/65 sm:text-xl sm:leading-8">{intro}</p>}
            </Reveal>
          }
          note={note}
        />
      </Container>
    </section>
  );
}
