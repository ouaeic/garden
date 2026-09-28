import { useEffect, useRef, type CSSProperties } from 'react';
import type { Project, Task } from '@garden/contracts';
import { Sprite } from './Sprite';
import { stageOf, type Stage } from './StatusSprite';
import {
  bee,
  firefly,
  blooms,
  cloud,
  fence,
  growth,
  moon,
  speech,
  stone,
  sun,
  tree,
  tuft,
  type Frames
} from './sprites';
import './life.css';

const species = Object.keys(blooms) as (keyof typeof blooms)[];
function hash(value: string) {
  let result = 0;
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(result);
}

export function projectStage(project: Project, latest: Task | undefined): Stage {
  if (project.attentionCount) return 'needs';
  if (project.activeCount) return 'sprout';
  return latest ? stageOf(latest) : 'bloom';
}

const stageWords: Record<Stage, string> = {
  seed: 'waiting to start',
  sprout: 'growing',
  bud: 'paused',
  bloom: 'in bloom',
  wilted: 'needs recovery',
  needs: 'needs you',
  cut: 'stopped'
};

function plantFrames(project: Project, stage: Stage): Frames {
  if (stage !== 'bloom') return growth[stage];
  if (project.conversationCount >= 4) return [tree];
  return [blooms[species[hash(project.id) % species.length]!]];
}

/**
 * Your projects as a garden. Each is a plant whose growth is its state, in the order you planted
 * them; the sky follows your clock. Every plant is a button to its project, and the sentence under
 * the heading says in words what the picture shows.
 */
export default function GardenPlot({
  projects,
  tasks,
  onProject
}: {
  projects: Project[];
  tasks: Task[];
  onProject: (id: string) => void;
}) {
  const plot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const size = () => element.style.setProperty('--plot-width', `${element.clientWidth}px`);
    size();
    const observer = new ResizeObserver(size);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const hour = new Date().getHours();
  const night = hour >= 20 || hour < 6;
  const planted = [...projects]
    .filter((project) => !project.archivedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-24)
    .map((project) => {
      const latest = tasks.find((task) => task.id === project.latestTaskId);
      const stage = projectStage(project, latest);
      return { project, stage };
    });
  const counts = planted.reduce<Partial<Record<Stage, number>>>((total, { stage }) => {
    total[stage] = (total[stage] ?? 0) + 1;
    return total;
  }, {});
  const summary = (['needs', 'sprout', 'bloom', 'wilted', 'bud'] as const)
    .filter((stage) => counts[stage])
    .map((stage) => `${counts[stage]} ${stageWords[stage]}`)
    .join(' · ');
  const greeting = night ? 'Good evening' : hour < 12 ? 'Good morning' : 'Good afternoon';
  return (
    <section className="garden-plot-wrap" aria-labelledby="garden-plot-title">
      <header className="garden-plot-heading">
        <div>
          <p className="eyebrow">{greeting}</p>
          <h1 id="garden-plot-title">Your garden</h1>
        </div>
        <p>{planted.length ? summary : 'Plant your first idea below.'}</p>
      </header>
      <div className="garden-plot" ref={plot} data-perch>
        <div className="garden-plot-sky" aria-hidden="true">
          {night ? (
            <>
              <Sprite frames={[moon]} scale={3} className="garden-plot-sun" />
              {[18, 36, 64, 82].map((left, index) => (
                <span
                  key={`f${left}`}
                  className="garden-plot-firefly"
                  style={
                    {
                      left: `${left}%`,
                      top: `${56 + (index % 2) * 24}px`,
                      '--firefly-delay': `${index * -1.3}s`
                    } as CSSProperties
                  }
                >
                  <Sprite frames={firefly} fps={1.2} />
                </span>
              ))}
              {[12, 27, 41, 58, 73, 88].map((left, index) => (
                <i
                  key={left}
                  className="garden-plot-star"
                  style={
                    {
                      left: `${left}%`,
                      top: `${14 + ((index * 23) % 60)}px`,
                      '--star-time': `${2 + index * 0.7}s`
                    } as CSSProperties
                  }
                />
              ))}
            </>
          ) : (
            <Sprite frames={[sun]} scale={3} className="garden-plot-sun" />
          )}
          {[
            { top: 16, time: 300, delay: -40, rest: 0.42 },
            { top: 44, time: 420, delay: -260, rest: 0.68 }
          ].map((item) => (
            <span
              key={item.top}
              className="garden-plot-cloud"
              style={
                {
                  '--cloud-top': `${item.top}px`,
                  '--cloud-time': `${item.time}s`,
                  '--cloud-delay': `${item.delay}s`,
                  '--cloud-rest': item.rest
                } as CSSProperties
              }
            >
              <Sprite frames={[cloud]} scale={3} />
            </span>
          ))}
        </div>
        <div className="garden-plot-ground" aria-hidden="true" />
        <div className="garden-plot-scenery" aria-hidden="true">
          {[3, 9, 17, 26, 38, 44, 53, 61, 72, 79, 86, 93].map((left) => (
            <Sprite key={`t${left}`} frames={[tuft]} scale={3} style={{ left: `${left}%` }} />
          ))}
          {[14, 57, 83].map((left) => (
            <Sprite key={`s${left}`} frames={[stone]} scale={3} style={{ left: `${left}%` }} />
          ))}
          <Sprite frames={[fence]} scale={3} className="garden-plot-fence" />
        </div>
        <nav className="garden-plot-beds" aria-label="Projects in your garden">
          {planted.map(({ project, stage }) => (
            <button
              type="button"
              key={project.id}
              className="garden-plant"
              aria-label={`${project.title}, ${stageWords[stage]}`}
              onClick={() => onProject(project.id)}
            >
              <span className="garden-plant-tag" aria-hidden="true">
                {project.title}
              </span>
              {stage === 'sprout' && (
                <span className="garden-plant-bee" aria-hidden="true">
                  <Sprite frames={bee} scale={2} fps={8} />
                </span>
              )}
              {stage === 'needs' && (
                <span className="garden-plant-bubble" aria-hidden="true">
                  <Sprite frames={[speech]} scale={2} />
                </span>
              )}
              <Sprite
                frames={plantFrames(project, stage)}
                scale={6}
                fps={stage === 'sprout' ? 2 : 1}
              />
            </button>
          ))}
        </nav>
      </div>
    </section>
  );
}
