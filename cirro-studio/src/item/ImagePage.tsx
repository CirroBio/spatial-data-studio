// An image opened: an OME-TIFF drawn across the page with its channels in the left drawer,
// and the pipelines that find cells in it, which is how an image becomes spatial data.
import { useEffect, useState } from 'react';
import { PLOT_BACKGROUNDS } from '@cirrobio/spatial-viewer';
import { useStudio } from '../app/studio';
import { SettingsIcon, tint } from '../app/ui';
import { describeError } from '../cirro/session';
import type { ImageItem } from '../data/model';
import { Facts, kinOf } from './Facts';
import { MAX_CHANNELS, OmeTiffLens, openOmeTiff, type ImageChannel, type OpenedImage } from './OmeTiffLens';
import { PipelineLinks } from './PipelineLinks';
import { useDrawers, ViewFrame } from './ViewFrame';

export function ImagePage({ item }: { item: ImageItem }) {
  const { collection, library, catalog } = useStudio();
  const drawers = useDrawers(false);
  const [image, setImage] = useState<OpenedImage | null>(null);
  const [channels, setChannels] = useState<ImageChannel[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!item.viewable) return;
    let live = true;
    collection.fileUrl(item.datasetId, item.path)
      .then(({ url }) => openOmeTiff(url))
      .then((img) => {
        if (!live) return;
        setImage(img);
        setChannels(img.channels);
      }, (e: unknown) => live && setProblem(describeError(e)));
    return () => {
      live = false;
    };
  }, [collection, item]);
  const { from, into } = kinOf(item, library, (id) => catalog.byId.get(id)?.sourceIds ?? []);
  const visible = channels.filter((c) => c.visible).length;
  return (
    <div className="picture" style={tint('--sds-stage-image')}>
      <Facts title={item.label} item={item} kind="Image" stage="images" from={from} into={into} />
      <ViewFrame drawers={drawers}
        left={{
          label: 'Tasks',
          content: (
            <>
              <p className="task-heading">Make something new</p>
              <PipelineLinks datasetId={item.datasetId} purpose="segment" about="Find the cells in this image: the result is a SpatialData store, linked back to it." />
            </>
          ),
        }}
        right={{
          label: 'Display',
          icon: <SettingsIcon />,
          content: (
          <div className="caption">
            {image && <p className="answer">{image.width.toLocaleString()} × {image.height.toLocaleString()} px · {channels.length} channel{channels.length === 1 ? '' : 's'}</p>}
            {!item.viewable && <p className="answer">This format opens in Cirro's image viewer, not in the browser here.</p>}
            {problem && <p className="notice notice-danger">{problem}</p>}
            <ul className="channel-list">
              {channels.map((c, i) => (
                <li key={i}>
                  <label className="channel-row">
                    <input type="checkbox" checked={c.visible} disabled={!c.visible && visible >= MAX_CHANNELS}
                      onChange={() => setChannels((cs) => cs.map((x, j) => (j === i ? { ...x, visible: !x.visible } : x)))} />
                    <span className="legend-swatch" style={{ background: c.color }} />
                    <span>{c.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          ),
        }}
        main={(
          // Fluorescence adds light to black; a brightfield (RGB) slide is light already.
          <div className="view" style={{ background: PLOT_BACKGROUNDS[image?.isRgb ? 'light' : 'dark'] }}>
            {image ? <OmeTiffLens image={image} channels={channels} /> : <p className="view-empty muted">{item.viewable && !problem ? 'Reading the image…' : ''}</p>}
          </div>
        )} />
    </div>
  );
}
