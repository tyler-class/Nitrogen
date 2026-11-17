// AI Instructions: the owner's house rules for assistants, outside the page tree. It's an ordinary
// page underneath (marked with the role "ai_instructions"), made from the default template the
// first time and edited from there, shown here in its own frame.
import { Link } from 'react-router';
import { useTree } from '../lib/queries';
import { Icon } from '../components/Icon';
import { InfoTip } from '../components/InfoTip';
import { PageView } from './PageView';

/** What AI Instructions are, in a few lines (the ⓘ beside the heading). */
function About() {
  return (
    <InfoTip label="How AI Instructions work" size={20}>
      <p>
        AI Instructions are your house rules for assistants working in the wiki: where things go,
        how pages are named, which tags to use, how to write.
      </p>
      <p>
        It starts as a sensible default. Edit it like any page to make it yours: change, add or
        remove whatever you like.
      </p>
      <p>
        Every AI assistant you connect reads it before anything else and follows it over its general
        habits, picking up your changes the next time it connects. You can also ask an assistant to
        change it, like “add a rule that meeting notes go under their project”.
      </p>
    </InfoTip>
  );
}

export function AiInstructions() {
  const tree = useTree();
  const id = tree.data?.instructions_id ?? null;
  // AI Instructions lives inside AI Sessions: a clear way back there.
  const back = (
    <Link to="/sessions" className="back-link">
      <Icon name="back" size={18} /> AI sessions
    </Link>
  );
  // The server makes the page from the default template the first time, so there's always one.
  if (!id) return <div className="page-loading" aria-busy="true" />;
  return <PageView key={id} pageId={id} header={back} titleAddon={<About />} />;
}
