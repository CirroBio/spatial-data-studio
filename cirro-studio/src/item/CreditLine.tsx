// A dataset's credit as one line: whichever of its source, publisher and license the tags
// give. Credit comes from tags anyone who can edit a dataset (or host a publication) wrote,
// so only an http(s) address becomes a link.
import type { Credit } from '../cirro/cirro-publication';

const httpUrl = (url?: string) => (url && /^https?:\/\//i.test(url) ? url : undefined);

function Linked({ text, url }: { text: string; url?: string }) {
  const href = httpUrl(url);
  return href ? <a href={href} target="_blank" rel="noreferrer">{text}</a> : <>{text}</>;
}

export function CreditLine({ credit }: { credit: Partial<Credit> }) {
  return (
    <>
      data{credit.source && <> from <Linked text={credit.source} url={credit.url} /></>}
      {credit.by && <> by {credit.by}</>}
      {credit.license && <>, <Linked text={credit.license} url={credit.licenseUrl} /></>}
    </>
  );
}
