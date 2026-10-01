const express = require('express');
const router = express.Router();

const Product = require('../../models/product');
const Category = require('../../models/category');
const auth = require('../../middleware/auth');
const role = require('../../middleware/role');
const { ROLES } = require('../../constants');
const { uploadImages } = require('../../utils/uploadImage');

/**
 * Normalises a submitted GST percentage.
 *
 * Returns { error } for anything that isn't a percentage, or { value } with a
 * number. An empty/absent field means "unchanged" and yields value: undefined.
 */
const parseTaxRate = rate => {
  if (rate === undefined || rate === null || rate === '') return { value: undefined };

  const parsed = Number(rate);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return { error: 'Tax rate must be a number between 0 and 100.' };
  }

  return { value: parsed };
};

/**
 * An offer price is optional (0/empty = no offer), but when given it has to
 * undercut the actual price — otherwise the "% off" shown would be nonsense.
 * Returns an error message, or null when every variant is fine.
 */
const validateOfferPrices = variants => {
  for (const v of variants) {
    const offer = Number(v.offerPrice) || 0;
    if (offer < 0) return 'Offer price cannot be negative.';
    if (offer > 0 && offer >= Number(v.price)) {
      return 'Offer price must be lower than the actual price.';
    }
  }
  return null;
};

// GET all products (admin)
// router.get('/', async (req, res) => {
//   try {
//     const products = await Product.find({}).populate('category', 'name');
//     res.status(200).json({ products });
//   } catch (error) {
//     res.status(400).json({ error: 'Your request could not be processed. Please try again.' });
//   }
// });
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const products = await Product.find({})
      .populate('category', 'name')
      .limit(limit)
      .skip((page - 1) * limit);

    res.status(200).json({ products });
  } catch (error) {
    res.status(400).json({ error: 'Error fetching products' });
  }
});
// GET product by slug (public storefront) - MUST come before /:id
router.get('/item/:slug', async (req, res) => {
  try {
    const product = await Product.findOne({ slug: req.params.slug, isActive: true }).populate('category', 'name');
    if (!product) return res.status(404).json({ message: 'No product found.' });
    res.status(200).json({ product });
  } catch (error) {
    res.status(400).json({ error: 'Your request could not be processed. Please try again.' });
  }
});

// POST add product with variants
// router.post('/add', auth, role.check(ROLES.Admin, ROLES.Merchant, ROLES.Member), async (req, res) => {
//   try {
//     const { name, description, category, variants } = req.body;

//     if (!name || !description) {
//       return res.status(400).json({ error: 'Name and description are required.' });
//     }

//     if (!variants || !Array.isArray(variants) || variants.length === 0) {
//       return res.status(400).json({ error: 'At least one variant is required.' });
//     }

//     // Validate variants
//     const colors = variants.map(v => v.color?.toLowerCase());
//     const uniqueColors = new Set(colors);
//     if (uniqueColors.size !== colors.length) {
//       return res.status(400).json({ error: 'Each variant must have a unique color.' });
//     }

//     for (const v of variants) {
//       if (!v.color) return res.status(400).json({ error: 'Each variant must have a color.' });
//       if (!v.price || Number(v.price) <= 0) return res.status(400).json({ error: 'Each variant price must be greater than 0.' });
//     }

//     // Ensure exactly one default variant
//     const defaultCount = variants.filter(v => v.isDefault).length;
//     if (defaultCount === 0) variants[0].isDefault = true;
//     if (defaultCount > 1) variants.forEach((v, i) => { v.isDefault = i === 0; });

//     const product = new Product({ name, description, category: category || null, variants });
//     const saved = await product.save();

//     // Link product to category
//     if (category) {
//       await Category.findByIdAndUpdate(category, { $push: { products: saved._id } });
//     }

//     res.status(200).json({ success: true, message: 'Product added successfully!', product: saved });
//   } catch (error) {
//     console.error(error);
//     res.status(400).json({ error: 'Your request could not be processed. Please try again.' });
//   }
// });

router.post('/add', auth, role.check(ROLES.Admin, ROLES.Merchant, ROLES.Member), async (req, res) => {
  try {
    const { name, description, category, taxRate, variants } = req.body;

    if (!name || !description) {
      return res.status(400).json({ error: 'Name and description are required.' });
    }

    if (!variants || !Array.isArray(variants) || variants.length === 0) {
      return res.status(400).json({ error: 'At least one variant is required.' });
    }

    const tax = parseTaxRate(taxRate);

    if (tax.error) {
      return res.status(400).json({ error: tax.error });
    }

    const offerError = validateOfferPrices(variants);
    if (offerError) {
      return res.status(400).json({ error: offerError });
    }

    // Base64 from the admin becomes Cloudinary URLs; existing URLs pass through.
    const updatedVariants = [];
    for (const v of variants) {
      updatedVariants.push({
        ...v,
        images: await uploadImages(v.images, 'products')
      });
    }

    const product = new Product({
      name,
      description,
      category: category || null,
      taxRate: tax.value ?? 0,
      variants: updatedVariants
    });

    const saved = await product.save();

    if (category) {
      await Category.findByIdAndUpdate(category, { $push: { products: saved._id } });
    }

    res.status(200).json({
      success: true,
      message: 'Product added successfully!',
      product: saved
    });

  } catch (error) {
    console.error(error);
    res.status(400).json({ error: 'Your request could not be processed. Please try again.' });
  }
});
// PUT update product
router.put('/update/:id', auth, role.check(ROLES.Admin, ROLES.Merchant, ROLES.Member), async (req, res) => {
  try {
    const { name, description, category, taxRate, variants, isActive } = req.body;

    const tax = parseTaxRate(taxRate);

    if (tax.error) {
      return res.status(400).json({ error: tax.error });
    }

    if (variants) {
      // Only variants that actually name a colour need distinct ones. Without
      // this guard, two colourless variants would collide as duplicate ''.
      const colors = variants
        .map(v => v.color?.trim().toLowerCase())
        .filter(Boolean);
      if (new Set(colors).size !== colors.length) {
        return res.status(400).json({ error: 'Each variant must have a unique color.' });
      }
      const defaultCount = variants.filter(v => v.isDefault).length;
      if (defaultCount === 0) variants[0].isDefault = true;

      const offerError = validateOfferPrices(variants);
      if (offerError) {
        return res.status(400).json({ error: offerError });
      }
    }

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    if (name !== undefined) product.name = name;
    if (description !== undefined) product.description = description;
    if (category !== undefined) product.category = category || null;
    if (isActive !== undefined) product.isActive = isActive;
    if (tax.value !== undefined) product.taxRate = tax.value;
    // if (variants !== undefined) product.variants = variants;
    if (variants !== undefined) {
  // Base64 from the admin becomes Cloudinary URLs; existing URLs pass through.
  const updatedVariants = [];
  for (const v of variants) {
    updatedVariants.push({
      ...v,
      images: await uploadImages(v.images, 'products')
    });
  }

  product.variants = updatedVariants;
}
    product.updated = new Date();

    const updated = await product.save();

    res.status(200).json({ success: true, message: 'Product updated successfully!', product: updated });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: 'Your request could not be processed. Please try again.' });
  }
});

// DELETE product
router.delete('/delete/:id', auth, role.check(ROLES.Admin, ROLES.Merchant, ROLES.Member), async (req, res) => {
  try {
    await Product.deleteOne({ _id: req.params.id });
    res.status(200).json({ success: true, message: 'Product deleted successfully!' });
  } catch (error) {
    res.status(400).json({ error: 'Your request could not be processed. Please try again.' });
  }
});

// GET single product by id (admin) - MUST be last to avoid shadowing other /:id routes
router.get('/:id',async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).populate('category', 'name');
    if (!product) return res.status(404).json({ message: 'No product found.' });
    res.status(200).json({ product });
  } catch (error) {
    res.status(400).json({ error: 'Your request could not be processed. Please try again.' });
  }
});

module.exports = router;
