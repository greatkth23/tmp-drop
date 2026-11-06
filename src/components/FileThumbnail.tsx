import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { canPreviewImage } from '../../shared/preview';

export function FileThumbnail({ src, file, icon }: { src?: string; file?: File; icon: IconName }) {
  const [local, setLocal] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!file || !canPreviewImage(file.name, file.size)) return;
    const url = URL.createObjectURL(file);
    setLocal(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const source = local || src;
  useEffect(() => setFailed(false), [source]);
  return (
    <span className="file-icon">
      {source && !failed ? (
        <img
          className="file-thumbnail"
          src={source}
          alt=""
          loading="lazy"
          decoding="async"
          width="40"
          height="40"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon name={icon} size={24} />
      )}
    </span>
  );
}
