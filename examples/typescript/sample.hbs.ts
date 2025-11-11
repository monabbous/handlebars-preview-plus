type SampleMessage = {
  title: string;
  message: string;
};

interface SamplePreviewRecipe {
  data: SampleMessage;
}

export default function getSamplePreview(): SamplePreviewRecipe {
  return {
    data: {
      title: "TypeScript Companion Module",
      message: "This content comes from a .hbs.ts file compiled with your workspace tsconfig.",
    },
  };
}
