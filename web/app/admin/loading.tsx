import { PageSkeleton } from "../backoffice/skeleton";

// What stands in an admin page's place from the click until its rows are
// here: the back office's frame of a list, under the bar. Said outright,
// because the skeleton picks its frame from a back office address.
export default function Loading() {
  return <PageSkeleton shape="list" />;
}
