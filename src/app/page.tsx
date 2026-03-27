import ScanInput from "@/components/home/ScanInput";
import SavedSchemasList from "@/components/home/SavedSchemasList";

export default function HomePage() {
  return (
    <div className="mx-auto max-w-3xl">
      <ScanInput />
      <SavedSchemasList />
    </div>
  );
}
