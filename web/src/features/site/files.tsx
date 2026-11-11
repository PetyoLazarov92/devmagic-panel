import { Tabs } from '@/components/ui/tabs';
import { type Site } from '@devmagic-panel/shared';
import { useMemo } from 'react';
import { UploadsFromProduction } from '@/features/site/uploads-from-production';
import { filesHref, uploadsHref } from '@/lib/file-links';
import { navigate, useQueryParam } from '@/lib/router';
import { FileViewer } from './file-viewer';
import { FolderView } from './files-folder';
export { sortEntries } from './files-folder';

export function FilesTab({ site }: { site: Site }) {
  const file = useQueryParam('file');
  const dir = useQueryParam('dir') ?? '';
  const line = Number(useQueryParam('line')) || undefined;
  const edit = useQueryParam('edit') === '1';
  const wordpress = site.core.kind !== 'none';
  const uploads = useQueryParam('view') === 'uploads' && wordpress;
  const q = useQueryParam('find');
  const where = useQueryParam('in') === 'text' ? 'text' : 'name';
  const find = useMemo(() => (q ? { q, where } as const : null), [q, where]);
  if (file !== null) return <FileViewer key={file} site={site} file={file} line={line} edit={edit} />;
  return (
    <div className="grid gap-4">
      {wordpress && (
        <Tabs
          size="sm"
          label="What the Files tab shows"
          value={uploads ? 'uploads' : 'browse'}
          onChange={(v) => navigate(v === 'uploads' ? uploadsHref(site) : filesHref(site, { dir }), { scroll: false })}
          items={[{ value: 'browse', label: 'Browse' }, { value: 'uploads', label: 'Uploads from production' }]}
        />
      )}
      {uploads ? <UploadsFromProduction site={site} /> : <FolderView site={site} dir={dir} find={find} />}
    </div>
  );
}
