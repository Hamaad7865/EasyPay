import { PageSkeleton } from "../skeleton";

// The list leads to an invoice and back: without a frame of its own, going from one to the other would show nothing.
export default function Loading() {
  return <PageSkeleton shape="list" />;
}
