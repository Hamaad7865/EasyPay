import { PageSkeleton } from "./skeleton";

// What stands in a page's place from the click until its figures are here:
// the page's frame, its text as bars with a light passing over them. A folder
// whose pages lead to one another (reports, insights, tables) has a file like
// this one of its own, or going from one to the next would show nothing.
export default function Loading() {
  return <PageSkeleton />;
}
