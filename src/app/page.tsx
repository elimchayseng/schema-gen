import ScanInput from "@/components/home/ScanInput";
import SavedSchemasList from "@/components/home/SavedSchemasList";
import CrawlHistory from "@/components/home/CrawlHistory";

export default function HomePage() {
  return (
    <div className="mx-auto max-w-3xl">
      <ScanInput />
      <CrawlHistory />
      <SavedSchemasList />
    </div>
  );
}
