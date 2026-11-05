import { Navigate, useNavigate } from 'react-router';
import { pageHref } from '@shared/markdown';
import { errorMessage } from '../lib/api';
import { useCreatePage, useTree } from '../lib/queries';
import { useToast } from '../components/Toast';
import { Dashboard } from './Dashboard';

/** "/" opens the chosen home page (Settings), else the dashboard, else a welcome. */
export function Home() {
  const tree = useTree();
  const create = useCreatePage();
  const navigate = useNavigate();
  const toast = useToast();
  if (!tree.data) return <div className="page-loading" aria-busy="true" />;
  const { pages, home_id } = tree.data;
  const target = home_id ? pages.find((p) => p.id === home_id) : undefined;
  if (target) return <Navigate to={pageHref(target.id, target.title)} replace />;
  if (pages.length) return <Dashboard />;

  async function start() {
    try {
      const p = await create.mutateAsync({ title: 'Home', parent_id: null });
      navigate(`${pageHref(p.id, p.title)}?edit=1`);
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <div className="welcome">
      <img src="/favicon.svg" alt="" width={56} height={56} />
      <h1>Your wiki is empty</h1>
      <p>
        Pages live in a tree: every page can hold subpages. Write in markdown, link pages with
        [[Page title]], and paste images straight into the editor.
      </p>
      <button className="btn primary" onClick={start} disabled={create.isPending}>
        Create your first page
      </button>
      <p className="muted">
        Or connect Claude in Settings and ask it to set up a structure for you.
      </p>
    </div>
  );
}
