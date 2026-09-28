import type { CSSProperties } from 'react';
import { Sprite } from './Sprite';
import {
  bee,
  blooms,
  cloud,
  fence,
  growth,
  moon,
  sparrow,
  stone,
  sun,
  tree,
  tuft
} from './sprites';
import './life.css';

/** The title screen's garden: a small scene that plays while you sign in. */
export default function TitleScene() {
  const hour = new Date().getHours();
  const night = hour >= 20 || hour < 6;
  const plants = [blooms.tulip, tree, blooms.daisy, growth.sprout, blooms.sunflower, blooms.fern];
  return (
    <div className="garden-plot title-scene" aria-hidden="true">
      <div className="garden-plot-sky">
        <Sprite frames={[night ? moon : sun]} scale={3} className="garden-plot-sun" />
        {[
          { top: 16, time: 200, delay: -30, rest: 0.3 },
          { top: 40, time: 280, delay: -150, rest: 0.6 }
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
      <div className="garden-plot-ground" />
      <div className="garden-plot-scenery">
        {[6, 21, 35, 49, 63, 77, 91].map((left) => (
          <Sprite key={`t${left}`} frames={[tuft]} scale={3} style={{ left: `${left}%` }} />
        ))}
        <Sprite frames={[stone]} scale={3} style={{ left: '42%' }} />
        <Sprite frames={[fence]} scale={3} className="garden-plot-fence" />
      </div>
      <div className="garden-plot-beds">
        {plants.map((frames, index) => (
          <span key={index} className="garden-plant">
            {index === 3 && (
              <span className="garden-plant-bee">
                <Sprite frames={bee} scale={2} fps={8} />
              </span>
            )}
            {index === 1 && (
              <span className="title-scene-bird">
                <Sprite frames={sparrow.perch} scale={2} fps={1} />
              </span>
            )}
            <Sprite frames={frames} scale={6} fps={2} />
          </span>
        ))}
      </div>
    </div>
  );
}
