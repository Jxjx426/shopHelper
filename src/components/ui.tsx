"use client";
import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { X, PackageOpen } from "lucide-react";
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactElement<{
    id?: string;
    "aria-label"?: string;
    "aria-describedby"?: string;
  }>;
  hint?: string;
}) {
  const generatedId = useId();
  const id = children.props.id ?? generatedId;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, {
        id,
        "aria-label": children.props["aria-label"] ?? label,
        "aria-describedby": hint
          ? `${id}-hint`
          : children.props["aria-describedby"],
      })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <PackageOpen size={38} strokeWidth={1.5} />
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Progress({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label: string;
}) {
  return (
    <div className="progress-wrap">
      <div className="progress-label">
        <span>{label}</span>
        <strong>
          {done} / {total}
        </strong>
      </div>
      <progress value={done} max={total || 1} aria-label={label} />
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭窗口" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function ErrorText({ message }: { message: string }) {
  return message ? (
    <div className="inline-error" role="alert">
      {message}
    </div>
  ) : null;
}
