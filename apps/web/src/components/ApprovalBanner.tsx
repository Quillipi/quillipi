import { api } from '../api';
import { useApp } from '../store';

/** While an app waits for approval, the code to type on its approval page. */
export function ApprovalBanner() {
  const pending = useApp((state) => state.info?.remote?.pending);
  if (!pending) return null;
  return (
    <div className="banner approval" role="alert">
      <span>
        ✦ {pending.app} wants to use this notebook. On the approval page, type <strong className="approval-code">{pending.code}</strong>
      </span>
      <button type="button" onClick={() => void api.denyRemote()}>
        Deny
      </button>
    </div>
  );
}
