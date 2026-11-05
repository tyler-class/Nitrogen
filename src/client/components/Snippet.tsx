/** Search snippet with \u0001…\u0002 match markers turned into <mark>. */
export function Snippet({ text }: { text: string }) {
  const [lead, ...rest] = text.split('\u0001');
  return (
    <span className="snippet">
      {lead}
      {rest.map((part, i) => {
        const [hit, after] = part.split('\u0002');
        return (
          <span key={i}>
            <mark>{hit}</mark>
            {after}
          </span>
        );
      })}
    </span>
  );
}
